//go:build !windows

package main

import (
	"errors"
	"io"
	"time"
)

func dialDiscordIPC(_ time.Duration) (io.ReadWriteCloser, error) {
	return nil, errors.New("esta build do companion é Windows-only por enquanto")
}
