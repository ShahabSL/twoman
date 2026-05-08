//go:build !android || !cgo

package main

func configureAndroidNetwork(handle uint64) error {
	return nil
}

func bindAndroidSocket(handle uint64, fd uintptr) error {
	return nil
}
