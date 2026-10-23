package server

import (
	"testing"
)

func TestExpandWorkerSlotsLegacy(t *testing.T) {
	slots := expandWorkerSlots(nil, 3)
	if len(slots) != 3 {
		t.Fatalf("len=%d want 3", len(slots))
	}
	for i, s := range slots {
		want := "work#" + itoa(i+1)
		if s.Name != want || s.ProfileID != 0 {
			t.Fatalf("slot[%d]=%+v want name=%s profile=0", i, s, want)
		}
	}
	slots = expandWorkerSlots(nil, 0)
	if len(slots) != defaultWorkers {
		t.Fatalf("legacy 0 → defaultWorkers: got %d", len(slots))
	}
}

func TestExpandWorkerSlotsMulti(t *testing.T) {
	slots := expandWorkerSlots([]WorkerPoolConfig{
		{ProfileID: 1, Workers: 2},
		{ProfileID: 2, Workers: 3},
	}, 3)
	if len(slots) != 5 {
		t.Fatalf("len=%d want 5", len(slots))
	}
	want := []int64{1, 1, 2, 2, 2}
	for i, s := range slots {
		if s.ProfileID != want[i] || s.Name != "work#"+itoa(i+1) {
			t.Fatalf("slot[%d]=%+v want profile=%d", i, s, want[i])
		}
	}
}

func TestExpandWorkerSlotsSkipsInvalidFallsBack(t *testing.T) {
	slots := expandWorkerSlots([]WorkerPoolConfig{
		{ProfileID: 0, Workers: 2},
		{ProfileID: 1, Workers: 0},
	}, 4)
	if len(slots) != 4 || slots[0].ProfileID != 0 {
		t.Fatalf("all-invalid pools should fall back to legacy: %+v", slots)
	}
}

func TestValidateWorkerPools(t *testing.T) {
	if err := validateWorkerPools(nil); err != nil {
		t.Fatal(err)
	}
	if err := validateWorkerPools([]WorkerPoolConfig{}); err != nil {
		t.Fatal(err)
	}
	if err := validateWorkerPools([]WorkerPoolConfig{{ProfileID: 0, Workers: 1}}); err == nil {
		t.Fatal("expected profile_id error")
	}
	if err := validateWorkerPools([]WorkerPoolConfig{{ProfileID: 1, Workers: 0}}); err == nil {
		t.Fatal("expected workers error")
	}
	big := make([]WorkerPoolConfig, 0, 3)
	big = append(big, WorkerPoolConfig{ProfileID: 1, Workers: 40})
	big = append(big, WorkerPoolConfig{ProfileID: 2, Workers: 20})
	if err := validateWorkerPools(big); err == nil {
		t.Fatal("expected sum>50 error")
	}
	if err := validateWorkerPools([]WorkerPoolConfig{{ProfileID: 1, Workers: 3}, {ProfileID: 2, Workers: 3}}); err != nil {
		t.Fatal(err)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [16]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
