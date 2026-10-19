package server

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"
)

const maxRemarkRunes = 2000

func normalizeRemark(value string) (string, error) {
	value = strings.TrimSpace(value)
	if utf8.RuneCountInString(value) > maxRemarkRunes {
		return "", fmt.Errorf("备注最多 %d 个字符", maxRemarkRunes)
	}
	return value, nil
}

func (s *Server) updateScheduleRemark(w http.ResponseWriter, r *http.Request) {
	id, err := parseScheduleID(r)
	if err != nil || id <= 0 {
		writeErr(w, 400, "计划编号无效")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxTaskMetadataRequestSize)
	var request struct {
		Remark *string `json:"remark"`
	}
	if err := decode(r, &request); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeErr(w, 413, "请求正文过大")
		} else {
			writeErr(w, 400, err.Error())
		}
		return
	}
	if request.Remark == nil {
		writeErr(w, 400, "需要提供 remark")
		return
	}
	remark, err := normalizeRemark(*request.Remark)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	item, err := s.m.pg.UpdateTaskScheduleRemark(id, remark)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	if item == nil {
		writeErr(w, 404, "计划不存在")
		return
	}
	writeJSON(w, 200, item)
}
