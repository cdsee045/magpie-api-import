package clipboard

import (
	"bytes"
	"runtime"
	"testing"
	"unsafe"
)

// Exercise real Windows allocation/locking/copying without accessing the
// system clipboard, so native FFI availability is tested with public bytes.
func TestWindowsNativeMemoryCopy(t *testing.T) {
	source := []byte{1, 2, 3, 4, 5, 6}
	alloc := kernel32.NewProc("GlobalAlloc")
	free := kernel32.NewProc("GlobalFree")
	handle, _, _ := alloc.Call(2, uintptr(len(source))) // GMEM_MOVEABLE
	if handle == 0 {
		t.Fatal("GlobalAlloc failed")
	}
	defer free.Call(handle)
	ptr, _, _ := globalLock.Call(handle)
	if ptr == 0 {
		t.Fatal("GlobalLock failed")
	}
	moveMemory.Call(ptr, uintptr(unsafe.Pointer(&source[0])), uintptr(len(source)))
	runtime.KeepAlive(source)
	globalUnlock.Call(handle)
	data, err := copyGlobal(handle, 1024)
	if err != nil || !bytes.Equal(data[:len(source)], source) {
		t.Fatalf("native copy: %v", err)
	}
	if _, err := copyGlobal(handle, 1); err == nil {
		t.Fatal("accepted oversized native memory")
	}
}
