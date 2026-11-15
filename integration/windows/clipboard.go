// Package clipboard provides bounded, read-only clipboard access for Magpie's
// trusted Go host. It has no watcher, background goroutine or logging.
package clipboard

import (
	"context"
	"encoding/binary"
	"errors"
	"unicode/utf16"
)

const CreationPage = "providers/custom/new"

type Content struct {
	Kind string
	Text string
	PNG  []byte
}

// Read must receive the route from the host's own navigation state, never an
// untrusted iframe. The host must cancel ctx on navigation, also after Read.
func Read(ctx context.Context, hostPage string) (Content, error) {
	if hostPage != CreationPage {
		return Content{}, errors.New("clipboard access requires the custom provider creation page")
	}
	if err := ctx.Err(); err != nil {
		return Content{}, err
	}
	return readNative(ctx)
}

func decodeText(data []byte) (string, error) {
	if len(data) > 2*1024*1024 || len(data)%2 != 0 {
		return "", errors.New("clipboard text is too large or malformed")
	}
	units := make([]uint16, 0, len(data)/2)
	for i := 0; i+1 < len(data); i += 2 {
		v := binary.LittleEndian.Uint16(data[i:])
		if v == 0 {
			return string(utf16.Decode(units)), nil
		}
		units = append(units, v)
	}
	return "", errors.New("clipboard text is not terminated")
}
