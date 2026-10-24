package server

import "testing"

func TestWorkerCountForTaskUsesOverrideOrGlobalDefault(t *testing.T) {
	if got := workerCountForTask(&Task{WorkerCount: 5}, 3); got != 5 {
		t.Fatalf("override = %d, want 5", got)
	}
	if got := workerCountForTask(&Task{WorkerCount: 0}, 3); got != 3 {
		t.Fatalf("zero override = %d, want global 3", got)
	}
	if got := workerCountForTask(&Task{WorkerCount: -1}, 3); got != 3 {
		t.Fatalf("negative override = %d, want global 3", got)
	}
}
