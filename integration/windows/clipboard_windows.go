package clipboard

import (
	"context"
	"errors"
	"runtime"
	"syscall"
	"time"
	"unsafe"
)

var (
	user32           = syscall.NewLazyDLL("user32.dll")
	kernel32         = syscall.NewLazyDLL("kernel32.dll")
	openClipboard    = user32.NewProc("OpenClipboard")
	closeClipboard   = user32.NewProc("CloseClipboard")
	getClipboardData = user32.NewProc("GetClipboardData")
	isAvailable      = user32.NewProc("IsClipboardFormatAvailable")
	registerFormat   = user32.NewProc("RegisterClipboardFormatW")
	globalLock       = kernel32.NewProc("GlobalLock")
	globalUnlock     = kernel32.NewProc("GlobalUnlock")
	globalSize       = kernel32.NewProc("GlobalSize")
	moveMemory       = kernel32.NewProc("RtlMoveMemory")
)

func readNative(ctx context.Context) (Content, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	opened := false
	for attempt := 0; attempt < 5; attempt++ {
		if err := ctx.Err(); err != nil {
			return Content{}, err
		}
		if ok, _, _ := openClipboard.Call(0); ok != 0 {
			opened = true
			break
		}
		select {
		case <-ctx.Done():
			return Content{}, ctx.Err()
		case <-time.After(20 * time.Millisecond):
		}
	}
	if !opened {
		return Content{}, errors.New("clipboard is busy; retry on the current page")
	}
	defer closeClipboard.Call()
	if ok, _, _ := isAvailable.Call(13); ok != 0 { // CF_UNICODETEXT
		data, err := copyData(13, 2*1024*1024)
		if err != nil {
			return Content{}, err
		}
		text, err := decodeText(data)
		if err != nil {
			return Content{}, err
		}
		if err := ctx.Err(); err != nil {
			return Content{}, err
		}
		return Content{Kind: "text", Text: text}, nil
	}
	name, _ := syscall.UTF16PtrFromString("PNG")
	pngFormat, _, _ := registerFormat.Call(uintptr(unsafe.Pointer(name)))
	if pngFormat != 0 {
		if ok, _, _ := isAvailable.Call(pngFormat); ok != 0 {
			data, err := copyData(pngFormat, 20*1024*1024)
			if err != nil {
				return Content{}, err
			}
			if err := ctx.Err(); err != nil {
				return Content{}, err
			}
			return Content{Kind: "image", PNG: data}, nil
		}
	}
	for _, format := range []uintptr{17, 8} { // CF_DIBV5, CF_DIB
		if ok, _, _ := isAvailable.Call(format); ok == 0 {
			continue
		}
		data, err := copyData(format, 101*1024*1024)
		if err != nil {
			return Content{}, err
		}
		png, err := dibPNG(ctx, data)
		if err != nil {
			return Content{}, err
		}
		if len(png) > 20*1024*1024 {
			return Content{}, errors.New("clipboard image is too large")
		}
		return Content{Kind: "image", PNG: png}, nil
	}
	return Content{Kind: "empty"}, nil
}

func copyData(format, limit uintptr) ([]byte, error) {
	handle, _, _ := getClipboardData.Call(format)
	if handle == 0 {
		return nil, errors.New("clipboard format cannot be read")
	}
	return copyGlobal(handle, limit)
}

func copyGlobal(handle, limit uintptr) ([]byte, error) {
	size, _, _ := globalSize.Call(handle)
	if size == 0 || size > limit {
		return nil, errors.New("clipboard data is too large or empty")
	}
	ptr, _, _ := globalLock.Call(handle)
	if ptr == 0 {
		return nil, errors.New("clipboard data cannot be locked")
	}
	defer globalUnlock.Call(handle)
	// The system owns handle; copy while locked and never GlobalFree it.
	data := make([]byte, int(size))
	// Copy in the native call while the clipboard block is locked. No
	// uintptr-to-Go-pointer conversion is needed for the system-owned memory.
	moveMemory.Call(uintptr(unsafe.Pointer(&data[0])), ptr, size)
	runtime.KeepAlive(data)
	return data, nil
}
