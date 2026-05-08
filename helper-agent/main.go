package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
)

func main() {
	configPath := flag.String("config", "", "path to config JSON file")
	mode := flag.String("mode", "helper", "run as 'helper' or 'agent'")
	flag.Parse()
	if *configPath == "" {
		fmt.Fprintln(os.Stderr, "usage: twoman --config <path> [--mode helper|agent]")
		os.Exit(1)
	}

	cfg, err := loadConfig(*configPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	if err := setupLogging(cfg.LogPath); err != nil {
		log.Fatalf("logging: %v", err)
	}
	if err := configureAndroidNetwork(cfg.AndroidNetworkHandle); err != nil {
		log.Fatalf("android network bind: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	switch *mode {
	case "agent":
		runAgent(ctx, cfg, sigCh)
	default:
		runHelper(ctx, cfg, sigCh)
	}
}

func setupLogging(logPath string) error {
	if logPath == "" {
		return nil
	}
	if os.Getenv("TWOMAN_STDERR_ALREADY_LOGGED") == "1" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(logPath), 0700); err != nil {
		return err
	}
	file, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	log.SetOutput(io.MultiWriter(os.Stderr, file))
	return nil
}

func runHelper(ctx context.Context, cfg *Config, sigCh <-chan os.Signal) {
	rt, err := newHelperRuntime(cfg)
	if err != nil {
		log.Fatalf("runtime init: %v", err)
	}
	if err := rt.start(ctx); err != nil {
		log.Fatalf("runtime start: %v", err)
	}

	httpAddr := fmt.Sprintf("%s:%d", cfg.ListenHost, cfg.HTTPListenPort)
	socksAddr := fmt.Sprintf("%s:%d", cfg.ListenHost, cfg.SOCKSListenPort)

	httpLn, err := net.Listen("tcp", httpAddr)
	if err != nil {
		log.Fatalf("http listen %s: %v", httpAddr, err)
	}
	socksLn, err := net.Listen("tcp", socksAddr)
	if err != nil {
		log.Fatalf("socks listen %s: %v", socksAddr, err)
	}

	log.Printf("HTTP  proxy  → %s", httpLn.Addr().String())
	log.Printf("SOCKS5 proxy → %s", socksLn.Addr().String())
	if err := writeListenState(cfg, httpLn, socksLn); err != nil {
		log.Fatalf("write listen state: %v", err)
	}

	go serveHTTP(ctx, httpLn, rt)
	go serveSOCKS(ctx, socksLn, rt)

	select {
	case sig := <-sigCh:
		log.Printf("signal %v — shutting down", sig)
	case <-ctx.Done():
	}

	httpLn.Close()
	socksLn.Close()
	rt.stop()
	log.Println("stopped")
}

func writeListenState(cfg *Config, httpLn, socksLn net.Listener) error {
	if cfg.ListenStatePath == "" {
		return nil
	}
	httpAddr, _ := httpLn.Addr().(*net.TCPAddr)
	socksAddr, _ := socksLn.Addr().(*net.TCPAddr)
	payload := map[string]interface{}{
		"http_host":  cfg.ListenHost,
		"socks_host": cfg.ListenHost,
	}
	if httpAddr != nil {
		payload["http_port"] = httpAddr.Port
	} else {
		payload["http_port"] = cfg.HTTPListenPort
	}
	if socksAddr != nil {
		payload["socks_port"] = socksAddr.Port
	} else {
		payload["socks_port"] = cfg.SOCKSListenPort
	}
	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(cfg.ListenStatePath, data, 0600)
}

func runAgent(ctx context.Context, cfg *Config, sigCh <-chan os.Signal) {
	rt, err := newAgentRuntime(cfg)
	if err != nil {
		log.Fatalf("agent init: %v", err)
	}
	if err := rt.start(ctx); err != nil {
		log.Fatalf("agent start: %v", err)
	}

	select {
	case sig := <-sigCh:
		log.Printf("signal %v — shutting down", sig)
	case <-ctx.Done():
	}

	rt.stop()
	log.Println("agent stopped")
}
