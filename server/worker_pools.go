package server

import (
	"encoding/json"
	"fmt"
	"strings"
)

// settingWorkerPools stores the multi-model Work Agent pool config as a JSON array.
// Empty / unset → legacy single-pool mode using settings.workers + unbound runtime.
const settingWorkerPools = "worker_pools"

// maxWorkerPoolTotal is the hard upper bound on sum(pool.workers), matching the
// per-task override ceiling used elsewhere so a misconfigured UI can't spawn dozens
// of LLM sessions per task.
const maxWorkerPoolTotal = 50

// WorkerPoolConfig is one LLM profile's share of concurrent Work Agents.
type WorkerPoolConfig struct {
	ProfileID int64 `json:"profile_id"`
	Workers   int   `json:"workers"`
}

// WorkerSlot is one Engine.Run worker loop: Name is the claim/session id (work#N);
// ProfileID 0 means unbound (legacy task-router resolution).
type WorkerSlot struct {
	Name      string
	ProfileID int64
}

// validateWorkerPools checks a pools slice before persistence. Empty is allowed
// (clears multi-model mode). Non-empty requires every entry valid and total in 1..50.
func validateWorkerPools(pools []WorkerPoolConfig) error {
	if len(pools) == 0 {
		return nil
	}
	total := 0
	for i, p := range pools {
		if p.ProfileID <= 0 {
			return fmt.Errorf("worker_pools[%d].profile_id 必须 >0", i)
		}
		if p.Workers <= 0 {
			return fmt.Errorf("worker_pools[%d].workers 必须 >0", i)
		}
		total += p.Workers
	}
	if total > maxWorkerPoolTotal {
		return fmt.Errorf("worker_pools 合计 Worker 数最多 %d（当前 %d）", maxWorkerPoolTotal, total)
	}
	return nil
}

// expandWorkerSlots turns pool configs into a spawn plan. Empty pools → legacy:
// N unbound slots named work#1..N where N = legacyWorkers (clamped to >=1).
func expandWorkerSlots(pools []WorkerPoolConfig, legacyWorkers int) []WorkerSlot {
	if len(pools) == 0 {
		n := legacyWorkers
		if n <= 0 {
			n = defaultWorkers
		}
		out := make([]WorkerSlot, n)
		for i := 0; i < n; i++ {
			out[i] = WorkerSlot{Name: fmt.Sprintf("work#%d", i+1), ProfileID: 0}
		}
		return out
	}
	var out []WorkerSlot
	for _, p := range pools {
		if p.ProfileID <= 0 || p.Workers <= 0 {
			continue
		}
		for i := 0; i < p.Workers; i++ {
			out = append(out, WorkerSlot{
				Name:      fmt.Sprintf("work#%d", len(out)+1),
				ProfileID: p.ProfileID,
			})
		}
	}
	if len(out) == 0 {
		return expandWorkerSlots(nil, legacyWorkers)
	}
	return out
}

// WorkerPools returns the configured multi-model pools (nil/empty = legacy mode).
// Invalid entries in the stored JSON are skipped.
func (m *Manager) WorkerPools() []WorkerPoolConfig {
	if m == nil || m.pg == nil {
		return nil
	}
	v, ok, err := m.pg.GetSetting(settingWorkerPools)
	if err != nil || !ok || strings.TrimSpace(v) == "" {
		return nil
	}
	var raw []WorkerPoolConfig
	if json.Unmarshal([]byte(v), &raw) != nil {
		return nil
	}
	out := make([]WorkerPoolConfig, 0, len(raw))
	for _, p := range raw {
		if p.ProfileID > 0 && p.Workers > 0 {
			out = append(out, p)
		}
	}
	return out
}

// SetWorkerPools persists the multi-model pool config. An empty slice clears the
// setting (back to legacy single-pool Workers()). Applies to tasks started afterwards.
func (m *Manager) SetWorkerPools(pools []WorkerPoolConfig) error {
	if err := validateWorkerPools(pools); err != nil {
		return err
	}
	if len(pools) == 0 {
		return m.pg.SetSetting(settingWorkerPools, "")
	}
	b, err := json.Marshal(pools)
	if err != nil {
		return err
	}
	return m.pg.SetSetting(settingWorkerPools, string(b))
}

// WorkerSlots returns the expanded spawn plan for Engine.Run (read per task start).
func (m *Manager) WorkerSlots() []WorkerSlot {
	return expandWorkerSlots(m.WorkerPools(), m.Workers())
}
