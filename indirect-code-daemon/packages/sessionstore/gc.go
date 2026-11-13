package sessionstore

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"

	"indirect/indirect-code-daemon/internal/durable"
	"indirect/indirect-code-daemon/packages/linereader"
	"indirect/indirect-code-daemon/packages/runner"
)

const (
	// DefaultCompressLogsAfter compresses terminal .log files older than 24 hours.
	DefaultCompressLogsAfter = 24 * time.Hour

	// DefaultDeleteLogsAfter deletes .log / .log.zst files older than 30 days.
	DefaultDeleteLogsAfter = 30 * 24 * time.Hour

	// DefaultCASGracePeriod protects unreferenced CAS blobs younger than 1 hour.
	DefaultCASGracePeriod = 1 * time.Hour

	// DefaultMaxDaemonLogBytes rotates logs/daemon.log above 16 MiB.
	DefaultMaxDaemonLogBytes int64 = 16 << 20
)

// GCPolicy configures auxiliary log compression, expiration, CAS blob sweeping,
// and daemon log rotation.
type GCPolicy struct {
	CompressLogsAfter time.Duration
	DeleteLogsAfter   time.Duration
	CASGracePeriod    time.Duration
	MaxDaemonLogBytes int64
	Now               time.Time
}

// DefaultGCPolicy returns the standard production GC policy.
func DefaultGCPolicy() GCPolicy {
	return GCPolicy{
		CompressLogsAfter: DefaultCompressLogsAfter,
		DeleteLogsAfter:   DefaultDeleteLogsAfter,
		CASGracePeriod:    DefaultCASGracePeriod,
		MaxDaemonLogBytes: DefaultMaxDaemonLogBytes,
	}
}

func normalizeGCPolicy(p GCPolicy) GCPolicy {
	if p.CompressLogsAfter <= 0 {
		p.CompressLogsAfter = DefaultCompressLogsAfter
	}
	if p.DeleteLogsAfter <= 0 {
		p.DeleteLogsAfter = DefaultDeleteLogsAfter
	}
	if p.CASGracePeriod <= 0 {
		p.CASGracePeriod = DefaultCASGracePeriod
	}
	if p.MaxDaemonLogBytes <= 0 {
		p.MaxDaemonLogBytes = DefaultMaxDaemonLogBytes
	}
	if p.Now.IsZero() {
		p.Now = time.Now()
	}
	return p
}

// GCStats summarizes the work performed by RunDiskGC.
type GCStats struct {
	CompressedLogs   int   `json:"compressedLogs"`
	DeletedLogs      int   `json:"deletedLogs"`
	DeletedBlobs     int   `json:"deletedBlobs"`
	RotatedDaemonLog bool  `json:"rotatedDaemonLog"`
	BytesReclaimed   int64 `json:"bytesReclaimed"`
}

// PurgeSessionDisk removes all on-disk artifacts belonging to sessionID across
// slotDir and rootDir:
//   - <slotDir>/sessions/<sessionID>/
//   - <slotDir>/sessions/<sessionID>.jsonl
//   - <slotDir>/sessions/<sessionID>.wal.jsonl
//   - <rootDir>/brain/<sessionID>/
//   - <rootDir>/executions/<sessionID>/
//   - <rootDir>/runners/out/<sessionID>__*
func PurgeSessionDisk(rootDir, slotDir, sessionID string) error {
	if !ValidSessionID(sessionID) {
		return ErrInvalidSessionID
	}

	var firstErr error
	recordErr := func(err error) {
		if err != nil && !os.IsNotExist(err) && firstErr == nil {
			firstErr = err
		}
	}

	if slotDir != "" {
		sessRoot := filepath.Join(slotDir, "sessions")
		recordErr(os.RemoveAll(filepath.Join(sessRoot, sessionID)))
		recordErr(os.Remove(filepath.Join(sessRoot, sessionID+".jsonl")))
		recordErr(os.Remove(filepath.Join(sessRoot, sessionID+".wal.jsonl")))
		recordErr(os.Remove(filepath.Join(sessRoot, sessionID+".json")))
	}

	if rootDir != "" {
		if rootDir != slotDir {
			// Also clean root-level sessions paths if rootDir shares or mirrors sessions.
			sessRoot := filepath.Join(rootDir, "sessions")
			recordErr(os.RemoveAll(filepath.Join(sessRoot, sessionID)))
			recordErr(os.Remove(filepath.Join(sessRoot, sessionID+".jsonl")))
			recordErr(os.Remove(filepath.Join(sessRoot, sessionID+".wal.jsonl")))
			recordErr(os.Remove(filepath.Join(sessRoot, sessionID+".json")))
		}
		recordErr(os.RemoveAll(filepath.Join(rootDir, "brain", sessionID)))
		recordErr(os.RemoveAll(filepath.Join(rootDir, "executions", sessionID)))

		outDir := filepath.Join(rootDir, "runners", "out")
		if entries, err := os.ReadDir(outDir); err == nil {
			prefix := sessionID + "__"
			for _, de := range entries {
				if de.IsDir() {
					continue
				}
				if strings.HasPrefix(de.Name(), prefix) {
					recordErr(os.Remove(filepath.Join(outDir, de.Name())))
				}
			}
		}
	}
	return firstErr
}

type activeJobSet struct {
	jobIDs map[string]struct{}
	paths  map[string]struct{}
}

func scanActiveRunnerJobs(rootDir string) activeJobSet {
	set := activeJobSet{
		jobIDs: make(map[string]struct{}),
		paths:  make(map[string]struct{}),
	}
	if rootDir == "" {
		return set
	}
	runnersDir := runner.RunnersDir(rootDir)
	entries, err := os.ReadDir(runnersDir)
	if err != nil {
		return set
	}
	for _, de := range entries {
		if de.IsDir() || !strings.HasSuffix(de.Name(), ".state.json") {
			continue
		}
		stemJobID := strings.TrimSuffix(de.Name(), ".state.json")
		fullPath := filepath.Join(runnersDir, de.Name())
		raw, rerr := os.ReadFile(fullPath)
		if rerr != nil {
			// Unreadable state file: fail closed and treat job as active.
			set.jobIDs[stemJobID] = struct{}{}
			continue
		}
		var probe struct {
			JobID     string `json:"jobId"`
			Status    string `json:"status"`
			LogPath   string `json:"logPath"`
			BrainPath string `json:"brainPath"`
		}
		if jerr := json.Unmarshal(raw, &probe); jerr != nil {
			set.jobIDs[stemJobID] = struct{}{}
			continue
		}
		isTerminal := probe.Status == runner.StatusDone || probe.Status == runner.StatusKilled
		if !isTerminal {
			set.jobIDs[stemJobID] = struct{}{}
			if probe.JobID != "" {
				set.jobIDs[probe.JobID] = struct{}{}
			}
			if probe.LogPath != "" {
				set.paths[filepath.Clean(probe.LogPath)] = struct{}{}
			}
			if probe.BrainPath != "" {
				set.paths[filepath.Clean(probe.BrainPath)] = struct{}{}
			}
		}
	}
	return set
}

func (a activeJobSet) isLogActive(path string) bool {
	clean := filepath.Clean(path)
	if _, ok := a.paths[clean]; ok {
		return true
	}
	base := filepath.Base(clean)
	stem := base
	switch {
	case strings.HasSuffix(stem, ".log.zst"):
		stem = strings.TrimSuffix(stem, ".log.zst")
	case strings.HasSuffix(stem, ".log"):
		stem = strings.TrimSuffix(stem, ".log")
	}
	if _, ok := a.jobIDs[stem]; ok {
		return true
	}
	// runners/out/<sessionId>__<jobId>__<startedAt>.log
	parts := strings.Split(stem, "__")
	if len(parts) >= 2 {
		if _, ok := a.jobIDs[parts[1]]; ok {
			return true
		}
	}
	return false
}

// RunDiskGC executes auxiliary log compression/pruning, unreferenced CAS blob
// sweeping, and daemon.log rotation according to policy.
func RunDiskGC(ctx context.Context, rootDir, slotDir string, policy GCPolicy) (GCStats, error) {
	policy = normalizeGCPolicy(policy)
	var stats GCStats

	if err := ctx.Err(); err != nil {
		return stats, err
	}

	if rootDir != "" {
		active := scanActiveRunnerJobs(rootDir)

		// 1. Prune >DeleteLogsAfter and compress >CompressLogsAfter in runners/out/*.
		if err := gcLogDirectory(ctx, filepath.Join(rootDir, "runners", "out"), false, active, policy, &stats); err != nil {
			return stats, err
		}

		// 2. Prune >DeleteLogsAfter and compress >CompressLogsAfter in brain/*/*.
		if err := gcLogDirectory(ctx, filepath.Join(rootDir, "brain"), true, active, policy, &stats); err != nil {
			return stats, err
		}

		// 3. Rotate <rootDir>/logs/daemon.log -> daemon.log.1 when > MaxDaemonLogBytes.
		rotated, reclaimed := rotateDaemonLogBestEffort(filepath.Join(rootDir, "logs", "daemon.log"), policy.MaxDaemonLogBytes)
		if rotated {
			stats.RotatedDaemonLog = true
			stats.BytesReclaimed += reclaimed
		}
	}

	// 4. Sweep unreferenced CAS blobs older than CASGracePeriod across all sessions + active WALs.
	if slotDir != "" {
		if err := sweepUnreferencedCASBlobs(ctx, rootDir, slotDir, policy, &stats); err != nil {
			return stats, err
		}
	}

	return stats, nil
}

func gcLogDirectory(ctx context.Context, baseDir string, oneSubdirLevel bool, active activeJobSet, policy GCPolicy, stats *GCStats) error {
	entries, err := os.ReadDir(baseDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if oneSubdirLevel {
		for _, de := range entries {
			if err := ctx.Err(); err != nil {
				return err
			}
			if !de.IsDir() {
				continue
			}
			if err := gcLogDirectory(ctx, filepath.Join(baseDir, de.Name()), false, active, policy, stats); err != nil {
				return err
			}
		}
		return nil
	}

	for _, de := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		if de.IsDir() {
			continue
		}
		name := de.Name()
		isRawLog := strings.HasSuffix(name, ".log")
		isZstLog := strings.HasSuffix(name, ".log.zst")
		if !isRawLog && !isZstLog {
			continue
		}
		fullPath := filepath.Join(baseDir, name)
		if active.isLogActive(fullPath) {
			continue
		}
		info, err := de.Info()
		if err != nil {
			continue
		}
		age := policy.Now.Sub(info.ModTime())

		// Delete logs older than DeleteLogsAfter (30d).
		if age > policy.DeleteLogsAfter {
			sz := info.Size()
			if err := os.Remove(fullPath); err == nil {
				stats.DeletedLogs++
				stats.BytesReclaimed += sz
			}
			continue
		}

		// Compress terminal .log files older than CompressLogsAfter (24h) into .log.zst.
		if isRawLog && age > policy.CompressLogsAfter {
			zstPath := fullPath + ".zst"
			origSize := info.Size()
			if err := compressFileStreamingZstd(fullPath, zstPath, info.ModTime()); err != nil {
				continue
			}
			var compSize int64
			if zfi, zerr := os.Stat(zstPath); zerr == nil {
				compSize = zfi.Size()
			}
			if err := os.Remove(fullPath); err == nil {
				stats.CompressedLogs++
				if origSize > compSize {
					stats.BytesReclaimed += origSize - compSize
				}
			}
		}
	}
	return nil
}

func rotateDaemonLogBestEffort(logPath string, maxBytes int64) (bool, int64) {
	fi, err := os.Stat(logPath)
	if err != nil || !fi.Mode().IsRegular() || fi.Size() <= maxBytes {
		return false, 0
	}
	backupPath := logPath + ".1"
	var prevBackupSize int64
	if bfi, berr := os.Stat(backupPath); berr == nil {
		prevBackupSize = bfi.Size()
	}
	if err := durable.Rename(logPath, backupPath); err == nil {
		syncDirBestEffort(filepath.Dir(logPath))
		return true, prevBackupSize
	}
	// Fallback when an open handle holds daemon.log on Windows: copy + truncate.
	if err := copyFileDurable(logPath, backupPath); err == nil {
		if terr := os.Truncate(logPath, 0); terr == nil {
			return true, prevBackupSize
		}
	}
	return false, 0
}

// extractHex64Tokens scans text for any 64-character hexadecimal substrings and
// inserts normalized lowercase digests into dst.
func extractHex64Tokens(text string, dst map[string]struct{}) {
	n := len(text)
	if n < 64 {
		return
	}
	run := 0
	for i := 0; i < n; i++ {
		ch := text[i]
		isHex := (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F')
		if isHex {
			run++
			if run == 64 {
				// Ensure the token is not part of a longer hex string (>64 chars).
				nextIsHex := false
				if i+1 < n {
					nc := text[i+1]
					nextIsHex = (nc >= '0' && nc <= '9') || (nc >= 'a' && nc <= 'f') || (nc >= 'A' && nc <= 'F')
				}
				if !nextIsHex {
					if norm, ok := NormalizeSHA256(text[i-63 : i+1]); ok {
						dst[norm] = struct{}{}
					}
				}
			}
		} else {
			run = 0
		}
	}
}

func scanJSONLFileForBlobHashes(path string, dst map[string]struct{}) error {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	defer f.Close()

	lr := linereader.New(bufio.NewReaderSize(f, 64*1024))
	for lr.Scan() {
		line := lr.Text()
		if strings.Contains(line, "Sha256") || strings.Contains(line, "sha256") {
			extractHex64Tokens(line, dst)
		}
	}
	return lr.Err()
}

func sweepUnreferencedCASBlobs(ctx context.Context, rootDir, slotDir string, policy GCPolicy, stats *GCStats) error {
	cas := NewCASStore(slotDir)
	blobsRoot := cas.RootDir()
	prefixDirs, err := os.ReadDir(blobsRoot)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	type candidate struct {
		hash string
		path string
		size int64
	}
	var candidates []candidate
	for _, pde := range prefixDirs {
		if !pde.IsDir() || len(pde.Name()) != 2 {
			continue
		}
		subPath := filepath.Join(blobsRoot, pde.Name())
		files, ferr := os.ReadDir(subPath)
		if ferr != nil {
			continue
		}
		for _, fde := range files {
			if fde.IsDir() || !strings.HasSuffix(fde.Name(), ".blob") {
				continue
			}
			hashStem := strings.TrimSuffix(fde.Name(), ".blob")
			norm, ok := NormalizeSHA256(hashStem)
			if !ok {
				continue
			}
			info, ierr := fde.Info()
			if ierr != nil {
				continue
			}
			if policy.Now.Sub(info.ModTime()) >= policy.CASGracePeriod {
				candidates = append(candidates, candidate{
					hash: norm,
					path: filepath.Join(subPath, fde.Name()),
					size: info.Size(),
				})
			}
		}
	}
	if len(candidates) == 0 {
		return nil
	}

	// Collect all live blob references across v2 sessions, legacy .jsonl files, and active WALs.
	referenced := make(map[string]struct{})
	store := New(slotDir)

	scanSessionsDir := func(sessRoot string) (bool, error) {
		entries, rerr := os.ReadDir(sessRoot)
		if rerr != nil {
			if os.IsNotExist(rerr) {
				return true, nil
			}
			// Fail closed: do not sweep blobs if sessions directory could not be read.
			return false, nil
		}
		for _, de := range entries {
			if err := ctx.Err(); err != nil {
				return false, err
			}
			name := de.Name()
			if de.IsDir() {
				sessDir := filepath.Join(sessRoot, name)
				// Check meta.json for any 64-hex references.
				if metaRaw, merr := os.ReadFile(filepath.Join(sessDir, metaFilename)); merr == nil {
					extractHex64Tokens(string(metaRaw), referenced)
				}
				mPath := filepath.Join(sessDir, manifestFilename)
				m, merr := readManifestFile(mPath)
				if merr != nil {
					if os.IsNotExist(merr) {
						continue
					}
					// Fail closed on corrupt/unreadable manifest.
					return false, nil
				}
				needFallbackScan := false
				for _, seg := range m.Segments {
					for _, ref := range seg.BlobRefs {
						if norm, ok := NormalizeSHA256(ref); ok {
							referenced[norm] = struct{}{}
						}
					}
					if !seg.HasBlobIndex && seg.TurnCount > 0 {
						needFallbackScan = true
					}
				}
				if needFallbackScan && sessRoot == store.SessionsDir() {
					msgs, _, terr := store.ReadTurnRange(name, 0, 0)
					if terr != nil {
						return false, nil
					}
					for _, ref := range CollectMessageBlobRefs(msgs) {
						referenced[ref] = struct{}{}
					}
				}
				continue
			}

			if strings.HasSuffix(name, ".jsonl") {
				if serr := scanJSONLFileForBlobHashes(filepath.Join(sessRoot, name), referenced); serr != nil {
					return false, nil
				}
			}
		}
		return true, nil
	}

	okSweep, err := scanSessionsDir(filepath.Join(slotDir, "sessions"))
	if err != nil || !okSweep {
		return err
	}
	if rootDir != "" && rootDir != slotDir {
		okRoot, rerr := scanSessionsDir(filepath.Join(rootDir, "sessions"))
		if rerr != nil || !okRoot {
			return rerr
		}
	}

	for _, cand := range candidates {
		if err := ctx.Err(); err != nil {
			return err
		}
		if _, live := referenced[cand.hash]; live {
			continue
		}
		// Re-stat right before unlink to honor grace period against concurrent PutBytes.
		info, stErr := os.Stat(cand.path)
		if stErr != nil || policy.Now.Sub(info.ModTime()) < policy.CASGracePeriod {
			continue
		}
		if err := os.Remove(cand.path); err == nil {
			stats.DeletedBlobs++
			stats.BytesReclaimed += cand.size
		}
	}
	return nil
}
