package clipboard

import (
	"bytes"
	"context"
	"encoding/binary"
	"image/png"
	"testing"
)

func TestReadRefusesOtherPagesBeforeNativeAccess(t *testing.T) {
	for _, page := range []string{"", "providers", "provider/editor", "settings"} {
		if _, err := Read(context.Background(), page); err == nil {
			t.Fatal("read outside creation page")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Read(ctx, CreationPage); err == nil {
		t.Fatal("read after navigation cancellation")
	}
}
func TestUnicode(t *testing.T) {
	data := []byte{'A', 0, 0x2d, 0x4e, 0, 0}
	text, err := decodeText(data)
	if err != nil || text != "A中" {
		t.Fatalf("decode: %v", err)
	}
	for _, data := range [][]byte{{1}, {1, 0}, make([]byte, 2*1024*1024+2)} {
		if _, err := decodeText(data); err == nil {
			t.Fatal("accepted malformed or oversized text")
		}
	}
}
func bitmap(topDown bool) []byte {
	data := make([]byte, 48)
	binary.LittleEndian.PutUint32(data, 40)
	binary.LittleEndian.PutUint32(data[4:], 1)
	height := int32(2)
	if topDown {
		height = -2
	}
	binary.LittleEndian.PutUint32(data[8:], uint32(height))
	binary.LittleEndian.PutUint16(data[12:], 1)
	binary.LittleEndian.PutUint16(data[14:], 24)
	copy(data[40:], []byte{255, 0, 0, 0, 0, 0, 255, 0})
	return data
}
func TestBitmapOrientationAndPadding(t *testing.T) {
	for _, topDown := range []bool{true, false} {
		data, err := dibPNG(context.Background(), bitmap(topDown))
		if err != nil {
			t.Fatal(err)
		}
		img, err := png.Decode(bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		r, _, b, _ := img.At(0, 0).RGBA()
		if topDown && b != 65535 || !topDown && r != 65535 {
			t.Fatal("incorrect orientation")
		}
	}
}
func TestBitmapRejectsTruncationAndExcessivePixels(t *testing.T) {
	data := bitmap(false)
	if _, err := dibPNG(context.Background(), data[:44]); err == nil {
		t.Fatal("accepted truncated pixels")
	}
	binary.LittleEndian.PutUint32(data[4:], 0x7fffffff)
	if _, err := dibPNG(context.Background(), data); err == nil {
		t.Fatal("accepted excessive pixels")
	}
}
func TestBitmapCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := dibPNG(ctx, bitmap(false)); err == nil {
		t.Fatal("ignored cancellation")
	}
}
