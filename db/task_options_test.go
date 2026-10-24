package db

import (
	"strings"
	"testing"
)

func TestTaskAndTemplateRemarkLimitIsShared(t *testing.T) {
	boundary := strings.Repeat("界", MaxTaskRemarkRunes)
	if _, _, err := normalizeTaskTemplateInput(TaskTemplateInput{Name: "n", Description: "d", Goal: "g", Remark: boundary}); err != nil {
		t.Fatalf("boundary remark rejected: %v", err)
	}
	if _, _, err := normalizeTaskTemplateInput(TaskTemplateInput{Name: "n", Description: "d", Goal: "g", Remark: boundary + "界"}); err == nil {
		t.Fatal("oversized template remark accepted")
	}
}

func TestWorkerCountNormalizationAndLimit(t *testing.T) {
	if got := normalizeWorkerCount(-1); got != 0 {
		t.Fatalf("negative worker count = %d, want 0", got)
	}
	if _, _, err := normalizeTaskTemplateInput(TaskTemplateInput{Name: "n", Description: "d", Goal: "g", WorkerCount: MaxTaskWorkerCount}); err != nil {
		t.Fatalf("maximum worker count rejected: %v", err)
	}
	if _, _, err := normalizeTaskTemplateInput(TaskTemplateInput{Name: "n", Description: "d", Goal: "g", WorkerCount: MaxTaskWorkerCount + 1}); err == nil {
		t.Fatal("oversized worker count accepted")
	}
}
