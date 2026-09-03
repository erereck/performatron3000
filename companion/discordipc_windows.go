//go:build windows

package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"time"
)

func dialDiscordIPC(timeout time.Duration) (io.ReadWriteCloser, error) {
	deadline := time.Now().Add(timeout)
	var lastErr error

	for time.Now().Before(deadline) {
		for i := 0; i < 10; i++ {
			// Discord documents the Windows IPC path as \\?\pipe\discord-ipc-N.
			// \\.\pipe\ is the Win32 equivalent accepted by CreateFile/OpenFile.
			path := fmt.Sprintf(`\\.\pipe\discord-ipc-%d`, i)
			f, err := os.OpenFile(path, os.O_RDWR, os.ModeNamedPipe)
			if err == nil {
				return f, nil
			}
			lastErr = err
		}
		time.Sleep(60 * time.Millisecond)
	}

	if lastErr == nil {
		lastErr = errors.New("nenhum discord-ipc encontrado")
	}
	return nil, lastErr
}
