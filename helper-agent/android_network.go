//go:build android && cgo

package main

/*
#cgo LDFLAGS: -landroid
#include <errno.h>
#include <stdint.h>
#include <android/multinetwork.h>

static int twoman_android_setprocnetwork_errno(uint64_t handle) {
	if (android_setprocnetwork((net_handle_t)handle) == 0) {
		return 0;
	}
	return errno;
}

static int twoman_android_setsocknetwork_errno(uint64_t handle, int fd) {
	if (android_setsocknetwork((net_handle_t)handle, fd) == 0) {
		return 0;
	}
	return errno;
}
*/
import "C"

import (
	"fmt"
	"log"
	"syscall"
)

func configureAndroidNetwork(handle uint64) error {
	if handle == 0 {
		return nil
	}
	if errno := C.twoman_android_setprocnetwork_errno(C.uint64_t(handle)); errno != 0 {
		return fmt.Errorf("android_setprocnetwork(%d): %w", handle, syscall.Errno(errno))
	}
	log.Printf("[android] helper process bound to network handle=%d", handle)
	return nil
}

func bindAndroidSocket(handle uint64, fd uintptr) error {
	if handle == 0 {
		return nil
	}
	if errno := C.twoman_android_setsocknetwork_errno(C.uint64_t(handle), C.int(fd)); errno != 0 {
		return fmt.Errorf("android_setsocknetwork(%d): %w", handle, syscall.Errno(errno))
	}
	return nil
}
