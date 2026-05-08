package main

import (
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"
	"time"
)

type adaptiveUploadController struct {
	mu     sync.Mutex
	lanes  map[string]*adaptiveUploadLane
	config AdaptiveUploadConfig
}

type adaptiveUploadLane struct {
	minWorkers     int
	currentWorkers int
	maxWorkers     int
	minBatchBytes  int
	currentBatch   int
	maxBatchBytes  int

	successes  int
	errors     int
	lastChange time.Time
}

func newAdaptiveUploadController(cfg AdaptiveUploadConfig, baseWorkers map[string]int, baseProfiles map[string]uploadProfile) *adaptiveUploadController {
	if !cfg.Enabled {
		return nil
	}
	lanes := cfg.Lanes
	if len(lanes) == 0 {
		lanes = []string{LaneData}
	}
	controller := &adaptiveUploadController{
		lanes:  make(map[string]*adaptiveUploadLane),
		config: cfg,
	}
	for _, lane := range lanes {
		lane = strings.TrimSpace(lane)
		if lane == "" {
			continue
		}
		baseWorkerCount := baseWorkers[lane]
		if baseWorkerCount < 1 {
			baseWorkerCount = 1
		}
		profile := baseProfiles[lane]
		if profile.maxBatchBytes <= 0 {
			profile.maxBatchBytes = defaultMaxFramePayloadBytes
		}

		minWorkers := positiveOr(cfg.MinWorkers, baseWorkerCount)
		initialWorkers := positiveOr(cfg.InitialWorkers, baseWorkerCount)
		maxWorkers := positiveOr(cfg.MaxWorkers, baseWorkerCount)
		if minWorkers > maxWorkers {
			minWorkers = maxWorkers
		}
		initialWorkers = clampInt(initialWorkers, minWorkers, maxWorkers)

		minBatch := positiveOr(cfg.MinBatchBytes, profile.maxBatchBytes)
		maxBatch := positiveOr(cfg.MaxBatchBytes, profile.maxBatchBytes)
		if minBatch > maxBatch {
			minBatch = maxBatch
		}
		initialBatch := clampInt(profile.maxBatchBytes, minBatch, maxBatch)

		controller.lanes[lane] = &adaptiveUploadLane{
			minWorkers:     minWorkers,
			currentWorkers: initialWorkers,
			maxWorkers:     maxWorkers,
			minBatchBytes:  minBatch,
			currentBatch:   initialBatch,
			maxBatchBytes:  maxBatch,
		}
	}
	if len(controller.lanes) == 0 {
		return nil
	}
	return controller
}

func (c *adaptiveUploadController) describe() string {
	if c == nil {
		return "disabled"
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	keys := make([]string, 0, len(c.lanes))
	for lane, state := range c.lanes {
		if state != nil {
			keys = append(keys, lane)
		}
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, lane := range keys {
		state := c.lanes[lane]
		parts = append(parts, fmt.Sprintf("%s workers=%d/%d batch=%d/%d", lane, state.currentWorkers, state.maxWorkers, state.currentBatch, state.maxBatchBytes))
	}
	return strings.Join(parts, " ")
}

func (c *adaptiveUploadController) maxWorkers(lane string, fallback int) int {
	if c == nil {
		return fallback
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	state := c.lanes[lane]
	if state == nil {
		return fallback
	}
	return state.maxWorkers
}

func (c *adaptiveUploadController) workerActive(lane string, workerIndex int) bool {
	if c == nil {
		return true
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	state := c.lanes[lane]
	return state == nil || workerIndex < state.currentWorkers
}

func (c *adaptiveUploadController) applyProfile(lane string, profile uploadProfile) uploadProfile {
	if c == nil {
		return profile
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	state := c.lanes[lane]
	if state == nil {
		return profile
	}
	profile.maxBatchBytes = state.currentBatch
	return profile
}

func (c *adaptiveUploadController) markSuccess(lane string, backlogFrames int, batchBytes int) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	state := c.lanes[lane]
	if state == nil {
		return
	}
	state.errors = 0
	if backlogFrames < c.backlogThreshold() && batchBytes < (state.currentBatch*3)/4 {
		state.successes = 0
		return
	}
	state.successes++
	if state.successes < c.increaseAfterSuccesses() || !c.decisionIntervalElapsed(state) {
		return
	}
	changed := false
	if state.currentWorkers < state.maxWorkers {
		state.currentWorkers++
		changed = true
	} else if state.currentBatch < state.maxBatchBytes {
		state.currentBatch = min2i(state.maxBatchBytes, state.currentBatch*2)
		changed = true
	}
	if changed {
		state.successes = 0
		state.lastChange = time.Now()
		log.Printf("[transport] adaptive upload increased lane=%s workers=%d/%d batch=%d/%d backlog_frames=%d batch_bytes=%d",
			lane, state.currentWorkers, state.maxWorkers, state.currentBatch, state.maxBatchBytes, backlogFrames, batchBytes)
	}
}

func (c *adaptiveUploadController) markError(lane string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	state := c.lanes[lane]
	if state == nil {
		return
	}
	state.successes = 0
	state.errors++
	if state.errors < c.decreaseAfterErrors() || !c.decisionIntervalElapsed(state) {
		return
	}
	changed := false
	if state.currentWorkers > state.minWorkers {
		// Congestion-control style multiplicative decrease reacts quickly when
		// the managed host starts refusing or resetting uploads.
		state.currentWorkers = max2i(state.minWorkers, state.currentWorkers/2)
		changed = true
	}
	if state.currentBatch > state.minBatchBytes {
		state.currentBatch = max2i(state.minBatchBytes, state.currentBatch/2)
		changed = true
	}
	if changed {
		state.errors = 0
		state.lastChange = time.Now()
		log.Printf("[transport] adaptive upload reduced lane=%s workers=%d/%d batch=%d/%d",
			lane, state.currentWorkers, state.maxWorkers, state.currentBatch, state.maxBatchBytes)
	}
}

func (c *adaptiveUploadController) increaseAfterSuccesses() int {
	return max2i(1, c.config.IncreaseAfterSuccesses)
}

func (c *adaptiveUploadController) decreaseAfterErrors() int {
	return max2i(1, c.config.DecreaseAfterErrors)
}

func (c *adaptiveUploadController) backlogThreshold() int {
	return max2i(1, positiveOr(c.config.BacklogThresholdFrames, 128))
}

func (c *adaptiveUploadController) decisionIntervalElapsed(state *adaptiveUploadLane) bool {
	interval := time.Duration(c.config.DecisionIntervalSeconds * float64(time.Second))
	if interval <= 0 || state.lastChange.IsZero() {
		return true
	}
	return time.Since(state.lastChange) >= interval
}

func positiveOr(value, fallback int) int {
	if value > 0 {
		return value
	}
	return fallback
}

func clampInt(value, low, high int) int {
	if value < low {
		return low
	}
	if value > high {
		return high
	}
	return value
}
