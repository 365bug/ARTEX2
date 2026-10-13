package server

import (
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/Autumn-27/artex/db"
	"github.com/Autumn-27/artex/intercept"
)

func TestJudgeConfigIncompleteScriptDefaultAndOverride(t *testing.T) {
	dsn := os.Getenv("ARTEX_PG_DSN")
	if dsn == "" {
		t.Skip("requires isolated ARTEX_PG_DSN")
	}
	pg, err := db.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pg.Close() })
	keys := []string{"llm_judge_enabled", "llm_judge_profile_id", "llm_judge_prompt", "llm_judge_timeout_seconds", "llm_judge_fail_action", "llm_judge_ask_timeout_seconds", "llm_judge_ask_timeout_action", "llm_judge_incomplete_script_action"}
	for _, key := range keys {
		value, exists, err := pg.GetSetting(key)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if exists {
				_, err = pg.Exec(`UPDATE settings SET value=$2 WHERE key=$1`, key, value)
			} else {
				_, err = pg.Exec(`DELETE FROM settings WHERE key=$1`, key)
			}
			if err != nil {
				t.Errorf("restore %s: %v", key, err)
			}
		})
	}
	s := &Server{m: &Manager{pg: pg, interceptor: intercept.New(pg)}}
	for _, tc := range []struct {
		option, want string
		code         int
	}{
		{"", "model", 200},
		{`,"incomplete_script_action":"ask"`, "ask", 200},
		{`,"incomplete_script_action":"model"`, "model", 200},
		{`,"incomplete_script_action":"invalid"`, "model", 400},
	} {
		req := httptest.NewRequest("PUT", "/api/intercept/judge-config", strings.NewReader(`{"fail_action":"allow","ask_timeout_action":"deny"`+tc.option+`}`))
		w := httptest.NewRecorder()
		s.interceptSetJudgeConfig(w, req)
		if w.Code != tc.code {
			t.Fatalf("option=%s status=%d body=%s", tc.option, w.Code, w.Body.String())
		}
		if got := s.m.interceptor.GetJudgeConfig().IncompleteScriptAction; got != tc.want {
			t.Fatalf("option=%s action=%s want=%s", tc.option, got, tc.want)
		}
	}
}
