package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
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

	log.Printf("HTTP  proxy  → %s", httpAddr)
	log.Printf("SOCKS5 proxy → %s", socksAddr)

	go serveHTTP(ctx, httpLn, rt)
	go serveSOCKS(ctx, socksLn, rt)

	select {
	case sig := <-sigCh:
		log.Printf("signal %v — shutting down", sig)
	case <-ctx.Done():
	}

	rt.stop()
	httpLn.Close()
	socksLn.Close()
	log.Println("stopped")
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
