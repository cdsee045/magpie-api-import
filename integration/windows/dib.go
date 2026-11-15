package clipboard

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"image"
	"image/png"
)

func dibPNG(ctx context.Context, data []byte) ([]byte, error) {
	invalid := errors.New("unsupported clipboard bitmap; copy text or a PNG instead")
	if len(data) < 40 {
		return nil, invalid
	}
	u32 := func(at int) uint32 { return binary.LittleEndian.Uint32(data[at:]) }
	header, width, height := int64(u32(0)), int64(int32(u32(4))), int64(int32(u32(8)))
	bits := int64(binary.LittleEndian.Uint16(data[14:]))
	compression := u32(16)
	if header != 40 && header != 108 && header != 124 {
		return nil, invalid
	}
	if header > int64(len(data)) || width <= 0 || height == 0 || (bits != 24 && bits != 32) || binary.LittleEndian.Uint16(data[12:]) != 1 {
		return nil, invalid
	}
	topDown := height < 0
	if topDown {
		height = -height
	}
	if width*height > 25_000_000 {
		return nil, errors.New("clipboard image has too many pixels")
	}
	offset := header
	if compression == 3 && bits == 32 {
		if len(data) < 52 {
			return nil, invalid
		}
		if u32(40) != 0x00ff0000 || u32(44) != 0x0000ff00 || u32(48) != 0x000000ff {
			return nil, invalid
		}
		if header == 40 {
			offset += 12
		}
	} else if compression != 0 {
		return nil, invalid
	}
	// High-bit-depth DIBs may still include a colour table.
	offset += int64(u32(32)) * 4
	stride := ((width*bits + 31) / 32) * 4
	if offset > int64(len(data)) || stride*height > int64(len(data))-offset {
		return nil, invalid
	}
	img := image.NewNRGBA(image.Rect(0, 0, int(width), int(height)))
	for y := int64(0); y < height; y++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		sourceY := y
		if !topDown {
			sourceY = height - 1 - y
		}
		for x := int64(0); x < width; x++ {
			at := offset + sourceY*stride + x*(bits/8)
			out := img.PixOffset(int(x), int(y))
			img.Pix[out], img.Pix[out+1], img.Pix[out+2], img.Pix[out+3] = data[at+2], data[at+1], data[at], 255
		}
	}
	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		return nil, errors.New("clipboard image conversion failed")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}
