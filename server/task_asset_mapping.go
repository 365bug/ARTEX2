package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

// taskAssetMapping starts a visible asset-mapper conversation for the task and
// then lets the graph refresh independently. The graph itself remains sourced
// from the database; the conversation is the audit trail for the explanation.
func (s *Server) taskAssetMapping(w http.ResponseWriter, r *http.Request) {
	t, ok := s.m.Task(r.PathValue("id"))
	if !ok {
		writeErr(w, http.StatusNotFound, "task not found")
		return
	}
	if s.m.pg == nil || s.chatAgentRef() == nil {
		writeErr(w, http.StatusServiceUnavailable, s.chatUnavailableReason())
		return
	}
	if agentInfo, err := s.m.pg.GetAgentByKey("asset_mapper"); err != nil || agentInfo == nil || !agentInfo.Enabled {
		writeErr(w, http.StatusServiceUnavailable, "资产梳理 Agent 未启用")
		return
	}
	taskID, _ := strconv.ParseInt(t.ID, 10, 64)
	description := strings.TrimSpace(t.Description)
	message := fmt.Sprintf("请重新梳理任务 #%d 的资产关系。只使用当前任务及其直接关联任务的真实资产数据，按互联网入口、边界服务、内网业务三层说明关系；不要探测、不要修改资产库，也不要把没有证据的连接描述成已验证通路。", taskID)
	if as := s.m.Assets(); as != nil {
		if graph, err := as.BuildCoverageGraph(taskID, t.ExpID); err == nil {
			snapshot, _ := json.Marshal(map[string]any{"nodes": graph.Nodes, "edges": graph.Edges})
			message += "\n\n页面刚读取的任务资产图真实快照如下；优先依据这份快照解释，避免把全局资产误当成本任务资产：\n" + string(snapshot)
		}
	}
	s.StartTriggeredRun("asset_mapper", fmt.Sprintf("资产梳理 · 任务 #%d", taskID), message, taskID, false, description, t.Goal)
	writeJSON(w, http.StatusAccepted, map[string]any{"status": "accepted", "agent_key": "asset_mapper"})
}
