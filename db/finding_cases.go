package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

var ErrFindingCaseConflict = errors.New("漏洞组已变更，请重新读取证据后再操作")

type FindingCase struct {
	ID             int64     `json:"id,string"`
	TaskID         *int64    `json:"task_id,string"`
	Title          string    `json:"title"`
	Reason         string    `json:"reason"`
	Severity       string    `json:"severity"`
	SeverityReason string    `json:"severity_reason"`
	Report         string    `json:"report,omitempty"`
	Version        int64     `json:"version"`
	ReportVersion  int64     `json:"report_version"`
	Active         bool      `json:"active"`
	Count          int       `json:"count"`
	Critical       int       `json:"critical"`
	High           int       `json:"high"`
	Medium         int       `json:"medium"`
	Low            int       `json:"low"`
	CreatedAt      time.Time `json:"created_at"`
}
type FindingCaseEvent struct {
	ID         int64           `json:"id,string"`
	Action     string          `json:"action"`
	Actor      string          `json:"actor"`
	Reason     string          `json:"reason"`
	FindingIDs json.RawMessage `json:"finding_ids"`
	CreatedAt  time.Time       `json:"created_at"`
}
type FindingCaseSuggestion struct {
	ID         int64    `json:"id,string"`
	TaskID     int64    `json:"task_id,string"`
	LeftID     int64    `json:"left_id,string"`
	RightID    int64    `json:"right_id,string"`
	Title      string   `json:"title"`
	Reason     string   `json:"reason"`
	State      string   `json:"state"`
	FindingIDs []string `json:"finding_ids"`
}
type FindingCaseRow struct {
	Case       *FindingCase `json:"case,omitempty"`
	FindingID  int64        `json:"finding_id,string,omitempty"`
	MatchedIDs []int64      `json:"matched_ids"`
}

const caseColumns = `c.id,c.task_id,c.title,c.reason,c.severity,c.severity_reason,c.report,c.version,c.report_version,c.active,c.created_at`

func scanCase(row interface{ Scan(...any) error }) (*FindingCase, error) {
	c := new(FindingCase)
	err := row.Scan(&c.ID, &c.TaskID, &c.Title, &c.Reason, &c.Severity, &c.SeverityReason, &c.Report, &c.Version, &c.ReportVersion, &c.Active, &c.CreatedAt)
	return c, err
}
func (d *DB) GetFindingCase(id int64) (*FindingCase, error) {
	c, err := scanCase(d.QueryRow(`SELECT `+caseColumns+` FROM finding_cases c WHERE id=$1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	err = d.QueryRow(`SELECT count(*),count(*) FILTER(WHERE severity='critical'),count(*) FILTER(WHERE severity='high'),count(*) FILTER(WHERE severity='medium'),count(*) FILTER(WHERE severity='low') FROM findings f JOIN finding_case_members m ON m.finding_id=f.id WHERE m.case_id=$1`, id).Scan(&c.Count, &c.Critical, &c.High, &c.Medium, &c.Low)
	return c, err
}
func (d *DB) FindingCaseID(id int64) (int64, error) {
	var cid int64
	err := d.QueryRow(`SELECT case_id FROM finding_case_members WHERE finding_id=$1`, id).Scan(&cid)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return cid, err
}
func (d *DB) FindingCaseMembers(id int64, page, size int) ([]*DBFinding, int, error) {
	var count int
	if err := d.QueryRow(`SELECT count(*) FROM finding_case_members WHERE case_id=$1`, id).Scan(&count); err != nil {
		return nil, 0, err
	}
	rows, err := d.Query(`SELECT `+findingSelectCols+` FROM findings f LEFT JOIN tasks t ON t.id=f.task_id JOIN finding_case_members m ON m.finding_id=f.id WHERE m.case_id=$1 ORDER BY f.id LIMIT $2 OFFSET $3`, id, size, (page-1)*size)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	fs, err := scanFindings(rows)
	return fs, count, err
}
func (d *DB) FindingCaseEvents(id int64) ([]FindingCaseEvent, error) {
	rows, err := d.Query(`SELECT id,action,actor,reason,finding_ids,created_at FROM finding_case_events WHERE case_id=$1 ORDER BY id DESC`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []FindingCaseEvent{}
	for rows.Next() {
		var e FindingCaseEvent
		if err := rows.Scan(&e.ID, &e.Action, &e.Actor, &e.Reason, &e.FindingIDs, &e.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
func (d *DB) ListFindingCases(filter FindingFilter, page, size int) ([]FindingCaseRow, int, error) {
	var err error
	filter, err = d.applyAssetScope(filter)
	if err != nil {
		return nil, 0, err
	}
	where, args := filter.where()
	base := `WITH matched AS (SELECT f.id,f.severity,f.created_at,COALESCE(m.case_id,0) cid FROM findings f LEFT JOIN tasks t ON t.id=f.task_id LEFT JOIN finding_case_members m ON m.finding_id=f.id` + where + `), entities AS (SELECT CASE WHEN cid>0 THEN 'c:'||cid ELSE 'f:'||id END key,MAX(cid) cid,MIN(id) fid,jsonb_agg(id ORDER BY id) matched_ids,MAX(created_at) created,MAX(CASE severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END) severity_rank FROM matched GROUP BY key)`
	var total int
	if err := d.QueryRow(base+` SELECT count(*) FROM entities`, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	order := `e.created DESC,e.fid DESC`
	if filter.Sort == "severity" {
		order = `e.severity_rank DESC,` + order
	}
	args = append(args, size, (page-1)*size)
	rows, err := d.Query(base+fmt.Sprintf(` SELECT e.cid,e.fid,e.matched_ids FROM entities e ORDER BY %s LIMIT $%d OFFSET $%d`, order, len(args)-1, len(args)), args...)
	if err != nil {
		return nil, 0, err
	}
	out := []FindingCaseRow{}
	groups := []int64{}
	for rows.Next() {
		var cid, fid int64
		var raw []byte
		if err := rows.Scan(&cid, &fid, &raw); err != nil {
			rows.Close()
			return nil, 0, err
		}
		r := FindingCaseRow{FindingID: fid}
		if err := json.Unmarshal(raw, &r.MatchedIDs); err != nil {
			rows.Close()
			return nil, 0, err
		}
		out = append(out, r)
		groups = append(groups, cid)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, 0, err
	}
	for i, cid := range groups {
		if cid > 0 {
			c, err := scanCase(d.QueryRow(`SELECT `+strings.Replace(caseColumns, "c.report,", "''::text,", 1)+` FROM finding_cases c WHERE id=$1`, cid))
			if err != nil {
				return nil, 0, err
			}
			if err := d.QueryRow(`SELECT count(*),count(*) FILTER(WHERE severity='critical'),count(*) FILTER(WHERE severity='high'),count(*) FILTER(WHERE severity='medium'),count(*) FILTER(WHERE severity='low') FROM findings f JOIN finding_case_members m ON m.finding_id=f.id WHERE m.case_id=$1`, cid).Scan(&c.Count, &c.Critical, &c.High, &c.Medium, &c.Low); err != nil {
				return nil, 0, err
			}
			out[i].Case = c
			out[i].FindingID = 0
		}
	}
	return out, total, nil
}

func sortedFindingIDs(ids []int64) ([]int64, error) {
	set := map[int64]bool{}
	out := []int64{}
	for _, id := range ids {
		if id <= 0 {
			return nil, errors.New("无效漏洞编号")
		}
		if !set[id] {
			set[id] = true
			out = append(out, id)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	if len(out) < 2 {
		return nil, errors.New("至少需要两条漏洞记录")
	}
	return out, nil
}
func lockCaseTask(tx *sql.Tx, taskID int64) error {
	if taskID <= 0 {
		return errors.New("归并需要仍存在的同一任务")
	}
	if _, err := tx.Exec(`SELECT pg_advisory_xact_lock($1)`, int64(5100000000000000)+taskID); err != nil {
		return err
	}
	var id int64
	return tx.QueryRow(`SELECT id FROM tasks WHERE id=$1 FOR UPDATE`, taskID).Scan(&id)
}
func (d *DB) MergeFindingCase(ctx context.Context, taskID int64, ids []int64, title, reason, actor string) (int64, error) {
	return d.mergeFindingCase(ctx, taskID, ids, title, reason, actor, 0, nil)
}

// mergeFindingCase merges ids into one folder. With suggestionID it also resolves
// that suggestion; dropped are suggestion members a human excluded, which are vetoed
// against the merged records so the same group is not suggested again.
func (d *DB) mergeFindingCase(ctx context.Context, taskID int64, ids []int64, title, reason, actor string, suggestionID int64, dropped []int64) (int64, error) {
	ids, err := sortedFindingIDs(ids)
	if err != nil {
		return 0, err
	}
	if strings.TrimSpace(title) == "" || strings.TrimSpace(reason) == "" {
		return 0, errors.New("必须提供漏洞名称及基于证据的归并理由")
	}
	var cid int64
	err = d.WithEvidenceTx(ctx, func(tx *sql.Tx) error {
		if err := lockCaseTask(tx, taskID); err != nil {
			return err
		}
		if suggestionID > 0 {
			var state string
			if err := tx.QueryRow(`SELECT state FROM finding_case_suggestions WHERE id=$1 FOR UPDATE`, suggestionID).Scan(&state); err != nil {
				return err
			}
			if state != "pending" {
				return ErrFindingCaseConflict
			}
		}
		groupSet := map[int64]bool{}
		for _, id := range ids {
			var tid sql.NullInt64
			var group int64
			if err := tx.QueryRow(`SELECT f.task_id,COALESCE(m.case_id,0) FROM findings f LEFT JOIN finding_case_members m ON m.finding_id=f.id WHERE f.id=$1`, id).Scan(&tid, &group); err != nil {
				return err
			}
			if !tid.Valid || tid.Int64 != taskID {
				return errors.New("只能归并同一任务的漏洞")
			}
			if group > 0 {
				groupSet[group] = true
			}
		}
		groups := []int64{}
		for g := range groupSet {
			groups = append(groups, g)
		}
		sort.Slice(groups, func(i, j int) bool { return groups[i] < groups[j] })
		all := map[int64]bool{}
		for _, id := range ids {
			all[id] = true
		}
		for _, g := range groups {
			rows, err := tx.Query(`SELECT finding_id FROM finding_case_members WHERE case_id=$1`, g)
			if err != nil {
				return err
			}
			for rows.Next() {
				var id int64
				if err := rows.Scan(&id); err != nil {
					rows.Close()
					return err
				}
				all[id] = true
			}
			err = rows.Err()
			rows.Close()
			if err != nil {
				return err
			}
		}
		ids = ids[:0]
		for id := range all {
			ids = append(ids, id)
		}
		sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
		raw, _ := json.Marshal(ids)
		var blocked bool
		if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM finding_case_blocks WHERE left_id IN(SELECT value::bigint FROM jsonb_array_elements_text($1::jsonb)) AND right_id IN(SELECT value::bigint FROM jsonb_array_elements_text($1::jsonb)))`, string(raw)).Scan(&blocked); err != nil {
			return err
		}
		if blocked {
			return errors.New("人工已否决或撤销这些记录的归并")
		}
		if len(groups) > 0 {
			cid = groups[0]
		} else {
			if err := tx.QueryRow(`INSERT INTO finding_cases(task_id,origin_task_id,title,reason) VALUES($1,$1,$2,$3) RETURNING id`, taskID, title, reason).Scan(&cid); err != nil {
				return err
			}
		}
		var changed int64
		for _, id := range ids {
			res, err := tx.Exec(`INSERT INTO finding_case_members(finding_id,case_id) VALUES($1,$2) ON CONFLICT(finding_id) DO UPDATE SET case_id=EXCLUDED.case_id WHERE finding_case_members.case_id<>EXCLUDED.case_id`, id, cid)
			if err != nil {
				return err
			}
			n, _ := res.RowsAffected()
			changed += n
		}
		for _, g := range groups {
			if g != cid {
				if _, err := tx.Exec(`UPDATE finding_cases SET active=false,version=version+1 WHERE id=$1`, g); err != nil {
					return err
				}
			}
		}
		if changed > 0 {
			if _, err := tx.Exec(`UPDATE finding_cases SET version=version+1 WHERE id=$1`, cid); err != nil {
				return err
			}
			if _, err := tx.Exec(`INSERT INTO finding_case_events(case_id,action,actor,reason,finding_ids) VALUES($1,'merge',$2,$3,$4)`, cid, actor, reason, string(raw)); err != nil {
				return err
			}
		}
		for _, x := range dropped {
			if all[x] {
				// Never pull an excluded record in through an existing folder.
				return fmt.Errorf("排除的记录 #%d 已与所选记录在同一文件夹，请先在文件夹中移出后再确认", x)
			}
			for _, y := range ids {
				if _, err := tx.Exec(`INSERT INTO finding_case_blocks(left_id,right_id,reason) VALUES(LEAST($1::bigint,$2::bigint),GREATEST($1::bigint,$2::bigint),'人工确认分组时排除') ON CONFLICT DO NOTHING`, x, y); err != nil {
					return err
				}
			}
		}
		if suggestionID > 0 {
			if _, err := tx.Exec(`UPDATE finding_case_suggestions SET state='accepted' WHERE id=$1`, suggestionID); err != nil {
				return err
			}
		}
		return sweepFindingCaseSuggestions(tx, taskID)
	})
	return cid, err
}
func (d *DB) RemoveFindingCaseMember(ctx context.Context, cid, fid int64, reason string) error {
	c, err := d.GetFindingCase(cid)
	if err != nil {
		return err
	}
	if c == nil {
		return errors.New("归并组不存在")
	}
	return d.WithEvidenceTx(ctx, func(tx *sql.Tx) error {
		var origin int64
		if err := tx.QueryRow(`SELECT origin_task_id FROM finding_cases WHERE id=$1`, cid).Scan(&origin); err != nil {
			return err
		}
		if _, err := tx.Exec(`SELECT pg_advisory_xact_lock($1)`, int64(5100000000000000)+origin); err != nil {
			return err
		}
		// Deleting a task retains its findings and folder history.
		var live int64
		if err := tx.QueryRow(`SELECT id FROM tasks WHERE id=$1 FOR UPDATE`, origin).Scan(&live); err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		var current int64
		if err := tx.QueryRow(`SELECT case_id FROM finding_case_members WHERE finding_id=$1`, fid).Scan(&current); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				var removed bool
				// A repeated removal, or a last member released by dissolution, is idempotent.
				err = tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM finding_case_events WHERE case_id=$1 AND finding_ids @> jsonb_build_array($2::bigint))`, cid, fid).Scan(&removed)
				if err == nil && removed {
					return nil
				}
			}
			return err
		}
		if current != cid {
			return ErrFindingCaseConflict
		}
		if _, err := tx.Exec(`INSERT INTO finding_case_blocks(left_id,right_id,reason) SELECT LEAST($1,finding_id),GREATEST($1,finding_id),$3 FROM finding_case_members WHERE case_id=$2 AND finding_id<>$1 ON CONFLICT DO NOTHING`, fid, cid, reason); err != nil {
			return err
		}
		if _, err := tx.Exec(`INSERT INTO finding_case_events(case_id,action,actor,reason,finding_ids) VALUES($1,'detach','human',$2,jsonb_build_array($3::bigint))`, cid, reason, fid); err != nil {
			return err
		}
		if _, err := tx.Exec(`DELETE FROM finding_case_members WHERE case_id=$1 AND finding_id=$2`, cid, fid); err != nil {
			return err
		}
		return sweepFindingCaseSuggestions(tx, origin)
	})
}
func (d *DB) UpdateFindingCaseReport(ctx context.Context, cid, version int64, title, report, severity, reason string) error {
	if !ValidSeverity(severity) || strings.TrimSpace(report) == "" || strings.TrimSpace(reason) == "" || strings.TrimSpace(title) == "" {
		return errors.New("完整报告、名称、有效等级和评级依据必填")
	}
	return d.WithEvidenceTx(ctx, func(tx *sql.Tx) error {
		c, err := scanCase(tx.QueryRow(`SELECT `+caseColumns+` FROM finding_cases c WHERE id=$1 FOR UPDATE`, cid))
		if err != nil {
			return err
		}
		if !c.Active || c.Version != version {
			return ErrFindingCaseConflict
		}
		if c.Title == title && c.Report == report && c.Severity == severity && c.SeverityReason == reason && c.ReportVersion == version {
			return nil
		}
		_, err = tx.Exec(`UPDATE finding_cases SET title=$2,report=$3,severity=$4,severity_reason=$5,report_version=$6 WHERE id=$1`, cid, title, report, severity, reason, version)
		if err != nil {
			return err
		}
		_, err = tx.Exec(`INSERT INTO finding_case_events(case_id,action,actor,reason) VALUES($1,'report_updated','reporter',$2)`, cid, "统一报告已更新；评级依据："+reason)
		return err
	})
}

// suggestionMembers returns the surviving member IDs of a suggestion in ascending order.
func suggestionMembers(q interface {
	Query(string, ...any) (*sql.Rows, error)
}, id int64) ([]int64, error) {
	rows, err := q.Query(`SELECT finding_id FROM finding_case_suggestion_members WHERE suggestion_id=$1 ORDER BY finding_id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []int64{}
	for rows.Next() {
		var fid int64
		if err := rows.Scan(&fid); err != nil {
			return nil, err
		}
		out = append(out, fid)
	}
	return out, rows.Err()
}

// A suggestion with a human-vetoed pair can never be accepted as a whole.
const pendingSuggestionHasBlockedPair = `EXISTS(SELECT 1 FROM finding_case_suggestion_members a JOIN finding_case_suggestion_members b ON a.suggestion_id=b.suggestion_id AND a.finding_id<b.finding_id
    JOIN finding_case_blocks bl ON bl.left_id=a.finding_id AND bl.right_id=b.finding_id WHERE a.suggestion_id=s.id)`

// sweepFindingCaseSuggestions resolves pending suggestions after a merge or veto:
// groups fully inside a merged folder are accepted and groups containing a vetoed
// pair become obsolete, so one confirmation clears all related cards.
func sweepFindingCaseSuggestions(tx *sql.Tx, taskID int64) error {
	if _, err := tx.Exec(`UPDATE finding_case_suggestions s SET state='accepted' WHERE s.task_id=$1 AND s.state='pending'
        AND (SELECT count(DISTINCT m.case_id) FROM finding_case_suggestion_members sm JOIN finding_case_members m ON m.finding_id=sm.finding_id WHERE sm.suggestion_id=s.id)=1
        AND NOT EXISTS(SELECT 1 FROM finding_case_suggestion_members sm LEFT JOIN finding_case_members m ON m.finding_id=sm.finding_id WHERE sm.suggestion_id=s.id AND m.case_id IS NULL)`, taskID); err != nil {
		return err
	}
	_, err := tx.Exec(`UPDATE finding_case_suggestions s SET state='obsolete' WHERE s.task_id=$1 AND s.state='pending' AND (`+pendingSuggestionHasBlockedPair+`
        OR (SELECT count(*) FROM finding_case_suggestion_members sm WHERE sm.suggestion_id=s.id)<2)`, taskID)
	return err
}

// SuggestFindingCase stores one pending group (2..20 same-task findings) for human
// confirmation. An identical pending group is refreshed, a pending superset is
// reused, and pending subsets are superseded by the new group.
func (d *DB) SuggestFindingCase(ctx context.Context, taskID int64, findingIDs []int64, title, reason string) (int64, error) {
	if strings.TrimSpace(title) == "" || strings.TrimSpace(reason) == "" {
		return 0, errors.New("建议需要名称和具体证据理由")
	}
	ids, err := sortedFindingIDs(findingIDs)
	if err != nil {
		return 0, err
	}
	if len(ids) > 20 {
		return 0, errors.New("疑似重复分组最多20条记录")
	}
	var id int64
	err = d.WithEvidenceTx(ctx, func(tx *sql.Tx) error {
		if err := lockCaseTask(tx, taskID); err != nil {
			return err
		}
		cases := map[int64]bool{}
		for _, fid := range ids {
			var tid sql.NullInt64
			var cid int64
			if err := tx.QueryRow(`SELECT f.task_id,COALESCE(m.case_id,0) FROM findings f LEFT JOIN finding_case_members m ON m.finding_id=f.id WHERE f.id=$1`, fid).Scan(&tid, &cid); err != nil {
				return err
			}
			if !tid.Valid || tid.Int64 != taskID {
				return errors.New("只能建议同一任务的归并")
			}
			cases[cid] = true
		}
		if len(cases) == 1 && !cases[0] {
			return errors.New("这些记录已在同一文件夹中，无需建议")
		}
		raw, _ := json.Marshal(ids)
		blocked := []string{}
		rows, err := tx.Query(`SELECT left_id,right_id FROM finding_case_blocks WHERE left_id IN(SELECT value::bigint FROM jsonb_array_elements_text($1::jsonb)) AND right_id IN(SELECT value::bigint FROM jsonb_array_elements_text($1::jsonb)) ORDER BY left_id,right_id`, string(raw))
		if err != nil {
			return err
		}
		for rows.Next() {
			var l, r int64
			if err := rows.Scan(&l, &r); err != nil {
				rows.Close()
				return err
			}
			blocked = append(blocked, fmt.Sprintf("#%d/#%d", l, r))
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		if len(blocked) > 0 {
			return fmt.Errorf("人工已否决这些记录的归并：%s；请去掉其中一方后重新提交", strings.Join(blocked, "、"))
		}
		// Compare against every pending group of the task; read all rows before issuing more statements.
		type pending struct {
			id      int64
			members map[int64]bool
		}
		groups := []pending{}
		rows, err = tx.Query(`SELECT s.id,sm.finding_id FROM finding_case_suggestions s JOIN finding_case_suggestion_members sm ON sm.suggestion_id=s.id WHERE s.task_id=$1 AND s.state='pending' ORDER BY s.id`, taskID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var sid, fid int64
			if err := rows.Scan(&sid, &fid); err != nil {
				rows.Close()
				return err
			}
			if len(groups) == 0 || groups[len(groups)-1].id != sid {
				groups = append(groups, pending{id: sid, members: map[int64]bool{}})
			}
			groups[len(groups)-1].members[fid] = true
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		want := map[int64]bool{}
		for _, fid := range ids {
			want[fid] = true
		}
		superseded := []int64{}
		for _, g := range groups {
			inNew := 0
			for fid := range g.members {
				if want[fid] {
					inNew++
				}
			}
			switch {
			case inNew == len(ids) && len(g.members) == len(ids):
				id = g.id
				_, err := tx.Exec(`UPDATE finding_case_suggestions SET title=$2,reason=$3 WHERE id=$1`, g.id, title, reason)
				return err
			case inNew == len(ids):
				// An existing pending group already covers every requested record.
				id = g.id
				return nil
			case inNew == len(g.members):
				superseded = append(superseded, g.id)
			}
		}
		for _, sid := range superseded {
			if _, err := tx.Exec(`UPDATE finding_case_suggestions SET state='superseded' WHERE id=$1 AND state='pending'`, sid); err != nil {
				return err
			}
		}
		if err := tx.QueryRow(`INSERT INTO finding_case_suggestions(task_id,left_id,right_id,title,reason) VALUES($1,$2,$3,$4,$5) RETURNING id`, taskID, ids[0], ids[1], title, reason).Scan(&id); err != nil {
			return err
		}
		_, err = tx.Exec(`INSERT INTO finding_case_suggestion_members(suggestion_id,finding_id) SELECT $1,value::bigint FROM jsonb_array_elements_text($2::jsonb)`, id, string(raw))
		return err
	})
	return id, err
}

// FindingCaseSuggestions lists pending groups with at least two surviving,
// non-vetoed members.
func (d *DB) FindingCaseSuggestions(taskID int64) ([]FindingCaseSuggestion, error) {
	rows, err := d.Query(`SELECT s.id,s.task_id,s.left_id,s.right_id,s.title,s.reason,s.state,COALESCE((SELECT jsonb_agg(sm.finding_id ORDER BY sm.finding_id) FROM finding_case_suggestion_members sm WHERE sm.suggestion_id=s.id),'[]'::jsonb)
        FROM finding_case_suggestions s WHERE s.state='pending' AND ($1::bigint=0 OR s.task_id=$1) AND NOT `+pendingSuggestionHasBlockedPair+`
        AND (SELECT count(*) FROM finding_case_suggestion_members sm WHERE sm.suggestion_id=s.id)>=2
        AND NOT EXISTS(SELECT 1 FROM finding_case_suggestion_members sm JOIN findings f ON f.id=sm.finding_id WHERE sm.suggestion_id=s.id AND f.task_id IS DISTINCT FROM s.task_id)
        ORDER BY s.id DESC`, taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []FindingCaseSuggestion{}
	for rows.Next() {
		var s FindingCaseSuggestion
		var raw []byte
		if err := rows.Scan(&s.ID, &s.TaskID, &s.LeftID, &s.RightID, &s.Title, &s.Reason, &s.State, &raw); err != nil {
			return nil, err
		}
		var members []int64
		if err := json.Unmarshal(raw, &members); err != nil {
			return nil, err
		}
		s.FindingIDs = make([]string, 0, len(members))
		for _, fid := range members {
			s.FindingIDs = append(s.FindingIDs, strconv.FormatInt(fid, 10))
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// ResolveFindingCaseSuggestion confirms or rejects a whole group. On accept the
// remaining members (minus exclude) are merged once; excluded records are vetoed
// against the remaining members. Rejecting vetoes every pair inside the group.
func (d *DB) ResolveFindingCaseSuggestion(ctx context.Context, id int64, accept bool, exclude []int64) (int64, error) {
	var s FindingCaseSuggestion
	if err := d.QueryRow(`SELECT task_id,left_id,right_id,title,reason,state FROM finding_case_suggestions WHERE id=$1`, id).Scan(&s.TaskID, &s.LeftID, &s.RightID, &s.Title, &s.Reason, &s.State); err != nil {
		return 0, err
	}
	if s.State != "pending" {
		return 0, ErrFindingCaseConflict
	}
	members, err := suggestionMembers(d, id)
	if err != nil {
		return 0, err
	}
	hasLeft, hasRight := false, false
	for _, x := range members {
		hasLeft = hasLeft || x == s.LeftID
		hasRight = hasRight || x == s.RightID
	}
	if len(members) < 2 || !hasLeft || !hasRight {
		return 0, ErrFindingCaseConflict
	}
	if accept {
		ex := map[int64]bool{}
		for _, x := range exclude {
			ex[x] = true
		}
		keep, dropped := []int64{}, []int64{}
		for _, x := range members {
			if ex[x] {
				dropped = append(dropped, x)
			} else {
				keep = append(keep, x)
			}
		}
		if len(keep) < 2 {
			return 0, errors.New("至少保留两条记录才能确认归并")
		}
		return d.mergeFindingCase(ctx, s.TaskID, keep, s.Title, s.Reason, "human", id, dropped)
	}
	return 0, d.WithEvidenceTx(ctx, func(tx *sql.Tx) error {
		if err := lockCaseTask(tx, s.TaskID); err != nil {
			return err
		}
		res, err := tx.Exec(`UPDATE finding_case_suggestions SET state='rejected' WHERE id=$1 AND state='pending'`, id)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n != 1 {
			return ErrFindingCaseConflict
		}
		// Re-read members under the task lock so the veto matches what was rejected.
		current, err := suggestionMembers(tx, id)
		if err != nil {
			return err
		}
		for i := range current {
			for j := i + 1; j < len(current); j++ {
				if _, err := tx.Exec(`INSERT INTO finding_case_blocks(left_id,right_id,reason) VALUES($1,$2,'人工否决') ON CONFLICT DO NOTHING`, current[i], current[j]); err != nil {
					return err
				}
			}
		}
		return sweepFindingCaseSuggestions(tx, s.TaskID)
	})
}

type FindingDistinctStats struct {
	Total      int `json:"total"`
	Reports    int `json:"reports"`
	Critical   int `json:"critical"`
	High       int `json:"high"`
	Medium     int `json:"medium"`
	Low        int `json:"low"`
	Unassessed int `json:"unassessed"`
}

func (d *DB) DistinctFindingStats(taskID string) (*FindingDistinctStats, error) {
	filter := FindingFilter{TaskID: taskID}
	where, args := filter.where()
	s := new(FindingDistinctStats)
	err := d.QueryRow(`WITH observations AS (SELECT f.id,f.severity,COALESCE(m.case_id,0) cid FROM findings f LEFT JOIN tasks t ON t.id=f.task_id LEFT JOIN finding_case_members m ON m.finding_id=f.id`+where+`), defects AS (SELECT severity FROM observations WHERE cid=0 UNION ALL SELECT c.severity FROM finding_cases c WHERE c.id IN(SELECT cid FROM observations WHERE cid>0)) SELECT count(*),(SELECT count(*) FROM observations),count(*) FILTER(WHERE severity='critical'),count(*) FILTER(WHERE severity='high'),count(*) FILTER(WHERE severity='medium'),count(*) FILTER(WHERE severity='low'),count(*) FILTER(WHERE severity='') FROM defects`, args...).Scan(&s.Total, &s.Reports, &s.Critical, &s.High, &s.Medium, &s.Low, &s.Unassessed)
	return s, err
}

// Compact candidate pages exclude PoC/report bodies and do not treat severity as identity.
// Recall stays broad (type OR name OR shared asset) so nothing is dropped, but rows are
// ranked: same vulnclass AND shared asset is "strong"; a single-condition hit is "weak".
// strong is the total number of strong candidates across all pages.
func (d *DB) FindingCaseCandidates(fid int64, page, size int, scope ...[]int64) (items []map[string]any, total int, strong int, err error) {
	f, err := d.FindingCaseSummary(fid)
	if err != nil {
		return nil, 0, 0, err
	}
	if f == nil || f.TaskID == nil {
		return nil, 0, 0, errors.New("漏洞任务不可用")
	}
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 100 {
		size = 20
	}
	assets, _ := json.Marshal(f.AssetIDs)
	if f.AssetIDs == nil {
		assets = []byte("[]")
	}
	// Type/asset/name only retrieve and rank candidates; the Reporter must still prove the root cause.
	hits := `SELECT f.*,
        (trim($3::text)<>'' AND lower(f.vulnclass)=lower($3)) AS same_class,
        (trim($4::text)<>'' AND lower(f.name)=lower($4)) AS same_name,
        EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(f.asset_ids)='array' THEN f.asset_ids ELSE '[]'::jsonb END) a WHERE a.value IN(SELECT value FROM jsonb_array_elements($5::jsonb))) AS shared_asset
        FROM findings f WHERE f.task_id=$1 AND f.id<>$2 AND NOT EXISTS(SELECT 1 FROM finding_case_blocks b WHERE b.left_id=LEAST(f.id,$2::bigint) AND b.right_id=GREATEST(f.id,$2::bigint))`
	args := []any{*f.TaskID, fid, f.VulnClass, f.Name, string(assets)}
	if len(scope) > 0 {
		raw, err := json.Marshal(scope[0])
		if err != nil {
			return nil, 0, 0, err
		}
		hits += ` AND f.id IN (SELECT jsonb_array_elements_text($6::jsonb)::bigint)`
		args = append(args, string(raw))
	}
	base := `WITH hits AS (` + hits + `), cand AS (SELECT h.*,
        (CASE WHEN same_class THEN 2 ELSE 0 END + CASE WHEN shared_asset THEN 2 ELSE 0 END + CASE WHEN same_name THEN 1 ELSE 0 END
         + CASE WHEN same_class AND shared_asset THEN 3 ELSE 0 END) AS score
        FROM hits h WHERE same_class OR same_name OR shared_asset)`
	if err := d.QueryRow(base+` SELECT count(*),count(*) FILTER(WHERE same_class AND shared_asset) FROM cand`, args...).Scan(&total, &strong); err != nil {
		return nil, 0, 0, err
	}
	args = append(args, size, (page-1)*size)
	rows, err := d.Query(base+fmt.Sprintf(` SELECT c.id,c.name,c.vulnclass,c.severity,left(c.summary,400),c.asset_ids,COALESCE(m.case_id,0),c.score,c.same_class,c.shared_asset,c.same_name
        FROM cand c LEFT JOIN finding_case_members m ON m.finding_id=c.id ORDER BY c.score DESC,c.id DESC LIMIT $%d OFFSET $%d`, len(args)-1, len(args)), args...)
	if err != nil {
		return nil, 0, 0, err
	}
	defer rows.Close()
	items = []map[string]any{}
	for rows.Next() {
		var id, cid int64
		var score int
		var sameClass, sharedAsset, sameName bool
		var name, class, severity, summary string
		var assetIDs json.RawMessage
		if err := rows.Scan(&id, &name, &class, &severity, &summary, &assetIDs, &cid, &score, &sameClass, &sharedAsset, &sameName); err != nil {
			return nil, 0, 0, err
		}
		reasons := []string{}
		if sameClass {
			reasons = append(reasons, "同漏洞类型")
		}
		if sharedAsset {
			reasons = append(reasons, "资产重叠")
		}
		if sameName {
			reasons = append(reasons, "同名称")
		}
		tier := "weak"
		if sameClass && sharedAsset {
			tier = "strong"
		}
		items = append(items, map[string]any{"finding_id": strconv.FormatInt(id, 10), "name": name, "vulnclass": class, "severity": severity, "summary": summary, "asset_ids": assetIDs, "case_id": strconv.FormatInt(cid, 10), "score": score, "tier": tier, "hit_reasons": reasons})
	}
	return items, total, strong, rows.Err()
}

// Batch task-list counters avoid an additional database round trip per task.
func (d *DB) DistinctFindingStatsByTask() (map[string]*FindingDistinctStats, error) {
	rows, err := d.Query(`WITH observations AS (
        SELECT f.task_id,CASE WHEN m.case_id IS NULL THEN 'f:'||f.id ELSE 'c:'||m.case_id END entity,
        CASE WHEN m.case_id IS NULL THEN f.severity ELSE c.severity END severity
        FROM findings f LEFT JOIN finding_case_members m ON m.finding_id=f.id LEFT JOIN finding_cases c ON c.id=m.case_id WHERE f.task_id IS NOT NULL)
        SELECT task_id,count(DISTINCT entity),count(*),
          count(DISTINCT entity) FILTER(WHERE severity='critical'),count(DISTINCT entity) FILTER(WHERE severity='high'),
          count(DISTINCT entity) FILTER(WHERE severity='medium'),count(DISTINCT entity) FILTER(WHERE severity='low'),
          count(DISTINCT entity) FILTER(WHERE severity='') FROM observations GROUP BY task_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]*FindingDistinctStats{}
	for rows.Next() {
		var id int64
		s := new(FindingDistinctStats)
		if err := rows.Scan(&id, &s.Total, &s.Reports, &s.Critical, &s.High, &s.Medium, &s.Low, &s.Unassessed); err != nil {
			return nil, err
		}
		out[strconv.FormatInt(id, 10)] = s
	}
	return out, rows.Err()
}

// Folder rows and candidate searches omit PoC bodies. The original table can
// request evidence for ungrouped rows without fetching report bodies.
func (d *DB) FindingCaseSummary(id int64, originalRow ...bool) (*DBFinding, error) {
	cols := strings.Replace(findingSelectCols, "f.evidence,", "''::text,", 1)
	if len(originalRow) > 0 && originalRow[0] {
		cols = findingSelectCols
	}
	rows, err := d.Query(`SELECT `+cols+` FROM findings f LEFT JOIN tasks t ON t.id=f.task_id WHERE f.id=$1`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	fs, err := scanFindings(rows)
	if err != nil || len(fs) == 0 {
		return nil, err
	}
	return fs[0], nil
}

// FindingCaseListContext contains bounded metadata for collapsed folder rows.
// Reports and member evidence are still fetched only when opened.
type FindingCaseListContext struct {
	TaskName        string
	TaskDescription string
	AssetIDs        []int64
	AssetCount      int
	LastFoundAt     time.Time
}

func (d *DB) FindingCaseListContexts(ids []int64) (map[int64]FindingCaseListContext, error) {
	result := map[int64]FindingCaseListContext{}
	if len(ids) == 0 {
		return result, nil
	}
	raw, err := json.Marshal(ids)
	if err != nil {
		return nil, err
	}
	rows, err := d.Query(`SELECT c.id,COALESCE(t.name,''),COALESCE(t.description,''),
    COALESCE((SELECT MAX(f.created_at) FROM finding_case_members m JOIN findings f ON f.id=m.finding_id WHERE m.case_id=c.id),c.created_at),
    COALESCE((SELECT jsonb_agg(v.id ORDER BY v.id) FROM (
        SELECT DISTINCT a.id FROM finding_case_members m JOIN findings f ON f.id=m.finding_id
        CROSS JOIN LATERAL jsonb_array_elements_text(f.asset_ids) e(v) JOIN assets a ON a.id=e.v::bigint
        WHERE m.case_id=c.id ORDER BY a.id LIMIT 4) v),'[]'::jsonb),
    (SELECT COUNT(DISTINCT a.id) FROM finding_case_members m JOIN findings f ON f.id=m.finding_id
        CROSS JOIN LATERAL jsonb_array_elements_text(f.asset_ids) e(v) JOIN assets a ON a.id=e.v::bigint WHERE m.case_id=c.id)
    FROM finding_cases c LEFT JOIN tasks t ON t.id=c.task_id
    WHERE c.id IN (SELECT jsonb_array_elements_text($1::jsonb)::bigint)`, string(raw))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var c FindingCaseListContext
		var assets []byte
		if err := rows.Scan(&id, &c.TaskName, &c.TaskDescription, &c.LastFoundAt, &assets, &c.AssetCount); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(assets, &c.AssetIDs); err != nil {
			return nil, err
		}
		result[id] = c
	}
	return result, rows.Err()
}
func (d *DB) MatchingFindingReportCount(filter FindingFilter) (int, error) {
	filter, err := d.applyAssetScope(filter)
	if err != nil {
		return 0, err
	}
	where, args := filter.where()
	var n int
	err = d.QueryRow(`SELECT COUNT(*) FROM findings f LEFT JOIN tasks t ON t.id=f.task_id`+where, args...).Scan(&n)
	return n, err
}
