package main

import "fmt"

var (
	version   = "dev"
	commit    = "unknown"
	buildTime = "unknown"
)

func versionText() string {
	return fmt.Sprintf("twoman-helper-agent %s commit=%s built=%s", version, commit, buildTime)
}
