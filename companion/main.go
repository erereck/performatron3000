package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

const listenAddress = "127.0.0.1:42421"

type server struct {
	rpc *DiscordRPC
}

type activityRequest struct {
	ClientID string         `json:"clientId"`
	Activity map[string]any `json:"activity"`
}

type clearRequest struct {
	ClientID string `json:"clientId"`
}

type apiResponse struct {
	OK               bool   `json:"ok"`
	Error            string `json:"error,omitempty"`
	DiscordConnected bool   `json:"discordConnected,omitempty"`
	ClientID         string `json:"clientId,omitempty"`
	Version          string `json:"version,omitempty"`
}

func main() {
	log.SetFlags(log.Ltime | log.Lmicroseconds)
	log.Println("Performatron 3000 Companion v0.1.0")
	log.Println("API local em http://" + listenAddress)
	log.Println("Abra o Discord Desktop e deixe este programa rodando enquanto quiser performar.")

	s := &server{rpc: NewDiscordRPC()}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/status", s.withCORS(s.status))
	mux.HandleFunc("/v1/activity", s.withCORS(s.activity))
	mux.HandleFunc("/v1/clear", s.withCORS(s.clear))

	httpServer := &http.Server{
		Addr:              listenAddress,
		Handler:           mux,
		ReadHeaderTimeout: 3 * time.Second,
		ReadTimeout:       5 * time.Second,
		WriteTimeout:      5 * time.Second,
		IdleTimeout:       30 * time.Second,
	}

	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func (s *server) status(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, apiResponse{OK: false, Error: "method not allowed"})
		return
	}

	writeJSON(w, http.StatusOK, apiResponse{
		OK:               true,
		DiscordConnected: s.rpc.Connected(),
		ClientID:         s.rpc.ClientID(),
		Version:          "0.1.0",
	})
}

func (s *server) activity(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, apiResponse{OK: false, Error: "method not allowed"})
		return
	}

	var req activityRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiResponse{OK: false, Error: err.Error()})
		return
	}
	if !validClientID(req.ClientID) {
		writeJSON(w, http.StatusBadRequest, apiResponse{OK: false, Error: "clientId inválido"})
		return
	}
	if len(req.Activity) == 0 {
		writeJSON(w, http.StatusBadRequest, apiResponse{OK: false, Error: "activity vazia"})
		return
	}

	if err := s.rpc.SetActivity(strings.TrimSpace(req.ClientID), req.Activity); err != nil {
		log.Printf("SET_ACTIVITY falhou: %v", err)
		writeJSON(w, http.StatusBadGateway, apiResponse{OK: false, Error: err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, apiResponse{OK: true, DiscordConnected: true, ClientID: strings.TrimSpace(req.ClientID)})
}

func (s *server) clear(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, apiResponse{OK: false, Error: "method not allowed"})
		return
	}

	var req clearRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiResponse{OK: false, Error: err.Error()})
		return
	}
	if !validClientID(req.ClientID) {
		writeJSON(w, http.StatusBadRequest, apiResponse{OK: false, Error: "clientId inválido"})
		return
	}

	if err := s.rpc.ClearActivity(strings.TrimSpace(req.ClientID)); err != nil {
		log.Printf("CLEAR_ACTIVITY ignorado: %v", err)
		writeJSON(w, http.StatusOK, apiResponse{OK: true, DiscordConnected: false})
		return
	}

	writeJSON(w, http.StatusOK, apiResponse{OK: true, DiscordConnected: true})
}

func (s *server) withCORS(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && !allowedOrigin(origin) {
			writeJSON(w, http.StatusForbidden, apiResponse{OK: false, Error: "origin não permitida"})
			return
		}

		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
		}
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next(w, r)
	}
}

func allowedOrigin(origin string) bool {
	return strings.HasPrefix(origin, "chrome-extension://") ||
		strings.HasPrefix(origin, "moz-extension://") ||
		strings.HasPrefix(origin, "edge-extension://")
}

func decodeJSON(r *http.Request, dst any) error {
	defer r.Body.Close()
	dec := json.NewDecoder(io.LimitReader(r.Body, 128*1024))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return fmt.Errorf("JSON inválido: %w", err)
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, payload apiResponse) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func validClientID(value string) bool {
	value = strings.TrimSpace(value)
	if len(value) < 15 || len(value) > 25 {
		return false
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func executablePID() int {
	return os.Getpid()
}
