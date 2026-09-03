package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"sync"
	"time"
)

const (
	opHandshake = 0
	opFrame     = 1
	opClose     = 2
	opPing      = 3
	opPong      = 4
)

type DiscordRPC struct {
	mu       sync.Mutex
	conn     io.ReadWriteCloser
	clientID string
}

func NewDiscordRPC() *DiscordRPC {
	return &DiscordRPC{}
}

func (d *DiscordRPC) Connected() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.conn != nil
}

func (d *DiscordRPC) ClientID() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.clientID
}

func (d *DiscordRPC) SetActivity(clientID string, activity map[string]any) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.commandWithRetry(clientID, activity)
}

func (d *DiscordRPC) ClearActivity(clientID string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.commandWithRetry(clientID, nil)
}

func (d *DiscordRPC) commandWithRetry(clientID string, activity any) error {
	if err := d.ensureConnected(clientID); err != nil {
		return err
	}
	if err := d.setActivity(activity); err == nil {
		return nil
	}

	// Discord may restart/update while the companion remains open. Reconnect once.
	d.closeLocked()
	if err := d.ensureConnected(clientID); err != nil {
		return err
	}
	return d.setActivity(activity)
}

func (d *DiscordRPC) ensureConnected(clientID string) error {
	if d.conn != nil && d.clientID == clientID {
		return nil
	}

	d.closeLocked()
	conn, err := dialDiscordIPC(1200 * time.Millisecond)
	if err != nil {
		return fmt.Errorf("não achei o Discord Desktop: %w", err)
	}

	d.conn = conn
	d.clientID = clientID

	handshake := map[string]any{
		"v":         1,
		"client_id": clientID,
	}
	if err := d.writeJSONFrame(opHandshake, handshake); err != nil {
		d.closeLocked()
		return fmt.Errorf("handshake falhou: %w", err)
	}

	if err := d.waitForReady(); err != nil {
		d.closeLocked()
		return err
	}

	return nil
}

func (d *DiscordRPC) waitForReady() error {
	for i := 0; i < 8; i++ {
		op, payload, err := d.readFrame()
		if err != nil {
			return fmt.Errorf("Discord não respondeu ao handshake: %w", err)
		}

		switch op {
		case opPing:
			if err := d.writeRawFrame(opPong, payload); err != nil {
				return err
			}
		case opClose:
			return fmt.Errorf("Discord fechou o RPC durante o handshake: %s", string(payload))
		case opFrame:
			var envelope struct {
				Evt  string `json:"evt"`
				Data struct {
					Code    int    `json:"code"`
					Message string `json:"message"`
				} `json:"data"`
			}
			_ = json.Unmarshal(payload, &envelope)
			if envelope.Evt == "READY" {
				return nil
			}
			if envelope.Evt == "ERROR" {
				return fmt.Errorf("Discord RPC %d: %s", envelope.Data.Code, envelope.Data.Message)
			}
		}
	}

	return errors.New("Discord abriu o pipe, mas não enviou READY")
}

func (d *DiscordRPC) setActivity(activity any) error {
	payload := map[string]any{
		"cmd": "SET_ACTIVITY",
		"args": map[string]any{
			"pid":      executablePID(),
			"activity": activity,
		},
		"nonce": strconv.FormatInt(time.Now().UnixNano(), 10),
	}

	if err := d.writeJSONFrame(opFrame, payload); err != nil {
		return fmt.Errorf("não consegui enviar presença: %w", err)
	}

	for i := 0; i < 8; i++ {
		op, raw, err := d.readFrame()
		if err != nil {
			return fmt.Errorf("Discord não confirmou a presença: %w", err)
		}

		switch op {
		case opPing:
			if err := d.writeRawFrame(opPong, raw); err != nil {
				return err
			}
			continue
		case opClose:
			return fmt.Errorf("Discord fechou o RPC: %s", string(raw))
		case opFrame:
			var envelope struct {
				Cmd  string `json:"cmd"`
				Evt  string `json:"evt"`
				Data struct {
					Code    int    `json:"code"`
					Message string `json:"message"`
				} `json:"data"`
			}
			if err := json.Unmarshal(raw, &envelope); err != nil {
				continue
			}
			if envelope.Evt == "ERROR" {
				return fmt.Errorf("Discord RPC %d: %s", envelope.Data.Code, envelope.Data.Message)
			}
			if envelope.Cmd == "SET_ACTIVITY" {
				return nil
			}
		}
	}

	return errors.New("Discord não confirmou SET_ACTIVITY")
}

func (d *DiscordRPC) writeJSONFrame(op uint32, value any) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return d.writeRawFrame(op, payload)
}

func (d *DiscordRPC) writeRawFrame(op uint32, payload []byte) error {
	if d.conn == nil {
		return errors.New("RPC não conectado")
	}
	if len(payload) > 16*1024*1024 {
		return errors.New("payload RPC grande demais")
	}

	header := make([]byte, 8)
	binary.LittleEndian.PutUint32(header[0:4], op)
	binary.LittleEndian.PutUint32(header[4:8], uint32(len(payload)))

	if err := writeAll(d.conn, header); err != nil {
		return err
	}
	return writeAll(d.conn, payload)
}

func (d *DiscordRPC) readFrame() (uint32, []byte, error) {
	if d.conn == nil {
		return 0, nil, errors.New("RPC não conectado")
	}

	header := make([]byte, 8)
	if _, err := io.ReadFull(d.conn, header); err != nil {
		return 0, nil, err
	}

	op := binary.LittleEndian.Uint32(header[0:4])
	length := binary.LittleEndian.Uint32(header[4:8])
	if length > 16*1024*1024 {
		return 0, nil, fmt.Errorf("frame RPC grande demais: %d bytes", length)
	}

	payload := make([]byte, int(length))
	if _, err := io.ReadFull(d.conn, payload); err != nil {
		return 0, nil, err
	}
	return op, payload, nil
}

func (d *DiscordRPC) closeLocked() {
	if d.conn != nil {
		_ = d.conn.Close()
	}
	d.conn = nil
	d.clientID = ""
}

func writeAll(w io.Writer, data []byte) error {
	for len(data) > 0 {
		n, err := w.Write(data)
		if err != nil {
			return err
		}
		data = data[n:]
	}
	return nil
}
