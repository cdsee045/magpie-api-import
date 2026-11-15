//go:build !windows

package clipboard

import (
	"context"
	"errors"
)

func readNative(context.Context) (Content, error) {
	return Content{}, errors.New("native clipboard import currently supports Windows only")
}
