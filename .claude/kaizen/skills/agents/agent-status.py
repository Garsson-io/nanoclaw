#!/usr/bin/env python3
"""Analyze running Claude Code agents — worktrees, sessions, progress, issues, PRs."""

import subprocess
import json
import os
import re
import sys
from pathlib import Path
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor

CLAUDE_PROJECTS_DIR = Path.home() / ".claude" / "projects"

# Repos where issues and PRs live
KAIZEN_REPO = "Garsson-io/kaizen"
NANOCLAW_REPO = "Garsson-io/nanoclaw"


def find_project_root():
    """Find the NanoClaw project root."""
    try:
        r = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True,
        )
        if r.returncode == 0 and r.stdout.strip():
            root = Path(r.stdout.strip())
            main = root
            wt_link = root / ".git"
            if wt_link.is_file():
                text = wt_link.read_text().strip()
                m = re.search(r"gitdir:\s*(.+)", text)
                if m:
                    gitdir = Path(m.group(1))
                    if "worktrees" in gitdir.parts:
                        main = gitdir.parent.parent.parent
            if (main / ".claude" / "worktrees").exists():
                return main
    except Exception:
        pass
    for p in [Path("/home/aviad/projects/nanoclaw"), Path.cwd()]:
        if (p / ".claude" / "worktrees").exists():
            return p
    return Path.cwd()


def get_running_agents():
    """Find running Claude processes with -w (worktree) flag."""
    r = subprocess.run(
        ["ps", "-eo", "pid,etimes,etime,args"],
        capture_output=True, text=True,
    )
    agents = []
    for line in r.stdout.splitlines()[1:]:
        parts = line.strip().split(None, 3)
        if len(parts) < 4:
            continue
        pid_s, etimes_s, etime, args = parts
        if "claude" not in args or "grep" in args:
            continue

        w_match = re.search(r"\bclaude\b.*\s-w\s+(\S+)", args)
        if not w_match:
            continue

        worktree = w_match.group(1)
        p_match = re.search(r"\s-p\s+(.+?)(?:\s*$)", args)
        cli_prompt = p_match.group(1).strip() if p_match else None
        skip_perms = "--dangerously-skip-permissions" in args

        agents.append({
            "pid": int(pid_s),
            "elapsed_seconds": int(etimes_s),
            "elapsed": etime,
            "worktree": worktree,
            "cli_prompt": cli_prompt,
            "headless": cli_prompt is not None,
            "skip_permissions": skip_perms,
        })
    return agents


def encode_path_for_claude_projects(path: Path) -> str:
    """Encode a filesystem path the way Claude stores project dirs.

    Rule: replace '/' with '-', replace '.' with '-'.
    """
    return str(path).replace("/", "-").replace(".", "-")


def find_session_file(worktree_name: str, project_root: Path):
    """Find the most recent session JSONL for a worktree."""
    if not CLAUDE_PROJECTS_DIR.exists():
        return None

    wt_path = project_root / ".claude" / "worktrees" / worktree_name
    encoded = encode_path_for_claude_projects(wt_path)
    session_dir = CLAUDE_PROJECTS_DIR / encoded

    if not session_dir.exists():
        candidates = [
            d for d in CLAUDE_PROJECTS_DIR.iterdir()
            if d.is_dir() and worktree_name in d.name
        ]
        if not candidates:
            return None
        session_dir = candidates[0]

    jsonl_files = [f for f in session_dir.glob("*.jsonl")]
    if not jsonl_files:
        return None

    return max(jsonl_files, key=lambda f: f.stat().st_mtime)


def count_subagents(session_file: Path) -> int:
    """Count active subagent session files."""
    subagent_dir = session_file.parent / session_file.stem / "subagents"
    if not subagent_dir.exists():
        return 0
    return len(list(subagent_dir.glob("*.jsonl")))


def parse_session(session_path: Path) -> dict:
    """Parse session JSONL — streaming, memory-efficient."""
    stat = session_path.stat()
    info = {
        "first_prompt": None,
        "latest_text": None,
        "user_messages": 0,
        "assistant_messages": 0,
        "tool_calls": 0,
        "started_at": None,
        "session_size": stat.st_size,
        "last_modified": datetime.fromtimestamp(stat.st_mtime),
        "subagents": count_subagents(session_path),
        "session_path": str(session_path),
    }

    with open(session_path) as f:
        for line in f:
            try:
                obj = json.loads(line.strip())
            except (json.JSONDecodeError, ValueError):
                continue

            t = obj.get("type")

            if t == "user":
                info["user_messages"] += 1
                if not info["started_at"]:
                    info["started_at"] = obj.get("timestamp")

                text = _extract_text(obj.get("message", {}))
                if text and not info["first_prompt"]:
                    info["first_prompt"] = text

            elif t == "assistant":
                info["assistant_messages"] += 1
                msg = obj.get("message", {})
                if isinstance(msg, dict):
                    content = msg.get("content", "")
                    if isinstance(content, list):
                        for block in content:
                            if not isinstance(block, dict):
                                continue
                            if (block.get("type") == "text"
                                    and len(block.get("text", "")) > 30):
                                info["latest_text"] = block["text"]
                            elif block.get("type") == "tool_use":
                                info["tool_calls"] += 1

    return info


def _extract_text(message) -> str:
    """Extract text from a user message (string or block list)."""
    if not isinstance(message, dict):
        return ""
    content = message.get("content", "")
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                t = block.get("text", "").strip()
                if t:
                    return t
    return ""


def get_git_info(worktree_path: Path) -> dict:
    """Get branch, dirty files, and new commits for a worktree."""
    def git(*args):
        r = subprocess.run(
            ["git", "-C", str(worktree_path)] + list(args),
            capture_output=True, text=True,
        )
        return r.stdout.strip()

    branch = git("branch", "--show-current")
    dirty = [l for l in git("status", "--short").splitlines() if l.strip()]
    commits = [l for l in git("log", "--oneline", "main..HEAD").splitlines()
               if l.strip()]

    return {"branch": branch, "dirty": dirty, "commits": commits}


def read_lock_file(worktree_path: Path) -> dict | None:
    """Read .worktree-lock.json for case info."""
    lock = worktree_path / ".worktree-lock.json"
    if not lock.exists():
        return None
    try:
        return json.loads(lock.read_text())
    except (json.JSONDecodeError, OSError):
        return None


def read_context_file(worktree_path: Path) -> dict | None:
    """Read .worktree-context.json for issue/PR tracking."""
    ctx = worktree_path / ".worktree-context.json"
    if not ctx.exists():
        return None
    try:
        return json.loads(ctx.read_text())
    except (json.JSONDecodeError, OSError):
        return None


# ---------------------------------------------------------------------------
# Issue & PR detection
# ---------------------------------------------------------------------------

def extract_kaizen_issue_from_case(case_name: str | None) -> int | None:
    """Extract kaizen issue number from case name pattern kNN."""
    if not case_name:
        return None
    m = re.search(r"-k(\d+)-", case_name)
    return int(m.group(1)) if m else None


def extract_issue_refs_from_text(text: str | None) -> list[int]:
    """Extract #NNN issue references from text."""
    if not text:
        return []
    return list(dict.fromkeys(int(m) for m in re.findall(r"#(\d+)", text)))


def extract_issue_refs_from_commits(commits: list[str]) -> list[int]:
    """Extract issue references from commit messages."""
    refs = []
    for commit in commits:
        refs.extend(extract_issue_refs_from_text(commit))
    return list(dict.fromkeys(refs))


def lookup_pr_for_branch(branch: str) -> dict | None:
    """Use gh CLI to find an open PR for a branch."""
    if not branch:
        return None
    try:
        r = subprocess.run(
            ["gh", "pr", "list",
             "--repo", NANOCLAW_REPO,
             "--head", branch,
             "--json", "number,title,url",
             "--limit", "1"],
            capture_output=True, text=True, timeout=10,
        )
        if r.returncode == 0:
            prs = json.loads(r.stdout)
            if prs:
                return prs[0]
    except (subprocess.TimeoutExpired, Exception):
        pass
    return None


def build_issue_url(issue_num: int, repo: str = KAIZEN_REPO) -> str:
    return f"https://github.com/{repo}/issues/{issue_num}"


def build_pr_url(pr_num: int, repo: str = NANOCLAW_REPO) -> str:
    return f"https://github.com/{repo}/pull/{pr_num}"


def resolve_issues_and_prs(data: dict, wt_path: Path, skip_gh: bool) -> None:
    """Populate data['issues'] and data['pr'] from all available sources.

    Sources (in priority order):
    1. .worktree-context.json  — explicit, written by agent convention
    2. Case name kNN pattern   — kaizen issue number
    3. CLI prompt #NNN refs    — headless agent launch prompt
    4. Commit message #NNN     — references in git history
    5. gh pr list --head       — GitHub API lookup for open PRs
    """
    issues: list[dict] = []          # [{number, url, source}]
    pr: dict | None = None           # {number, url, title, source}
    seen_issues: set[int] = set()

    def add_issue(num: int, source: str, repo: str = KAIZEN_REPO):
        if num not in seen_issues:
            seen_issues.add(num)
            issues.append({
                "number": num,
                "url": build_issue_url(num, repo),
                "source": source,
            })

    # 1. Context file (highest priority — agent explicitly recorded these)
    ctx = read_context_file(wt_path)
    if ctx:
        if ctx.get("issue_number"):
            add_issue(ctx["issue_number"], "context-file",
                      ctx.get("issue_repo", KAIZEN_REPO))
        if ctx.get("pr_number"):
            pr = {
                "number": ctx["pr_number"],
                "url": ctx.get("pr_url",
                               build_pr_url(ctx["pr_number"])),
                "title": ctx.get("pr_title", ""),
                "source": "context-file",
            }

    # 2. Case name kNN
    kaizen_num = extract_kaizen_issue_from_case(data.get("case_name"))
    if kaizen_num:
        add_issue(kaizen_num, "case-name")

    # 3. CLI prompt
    for num in extract_issue_refs_from_text(data.get("prompt")):
        add_issue(num, "cli-prompt")

    # 4. Commit messages
    for num in extract_issue_refs_from_commits(data.get("commit_list", [])):
        add_issue(num, "commit-message")

    # 5. gh pr list (skip if we already have a PR or --no-gh flag)
    if not pr and not skip_gh and data.get("branch"):
        gh_pr = lookup_pr_for_branch(data["branch"])
        if gh_pr:
            pr = {
                "number": gh_pr["number"],
                "url": gh_pr["url"],
                "title": gh_pr.get("title", ""),
                "source": "github-api",
            }

    data["issues"] = issues
    data["pr"] = pr


# ---------------------------------------------------------------------------
# Formatting
# ---------------------------------------------------------------------------

def format_size(n: int) -> str:
    for unit in ("B", "KB", "MB"):
        if n < 1024:
            return f"{n:.0f}{unit}" if unit == "B" else f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}GB"


def format_elapsed(seconds: int) -> str:
    if seconds < 60:
        return f"{seconds}s"
    m, s = divmod(seconds, 60)
    if m < 60:
        return f"{m}m{s:02d}s"
    h, m = divmod(m, 60)
    return f"{h}h{m:02d}m"


def trunc(text: str, max_len: int = 300) -> str:
    if not text:
        return ""
    text = text.strip().replace("\n", " ")
    if len(text) <= max_len:
        return text
    return text[:max_len] + "..."


def output_json(agents_data: list):
    print(json.dumps(agents_data, indent=2, default=str))


def output_markdown(agents_data: list):
    print(f"## Running Agents ({len(agents_data)} found)\n")

    for i, a in enumerate(agents_data, 1):
        mode = "headless" if a["headless"] else "interactive"
        perms = " | skip-perms" if a["skip_permissions"] else ""
        print(f"### {i}. `{a['worktree']}` ({mode}{perms})\n")

        # Core info table
        print("| | |")
        print("|---|---|")
        print(f"| PID | {a['pid']} |")
        print(f"| Elapsed | {a['elapsed_fmt']} |")

        if a.get("case_name"):
            print(f"| Case | `{a['case_name']}` |")
        if a.get("branch"):
            print(f"| Branch | `{a['branch']}` |")
        if a.get("new_commits") is not None:
            print(f"| Commits | {a['new_commits']} new |")
        if a.get("dirty_count") is not None:
            print(f"| Dirty files | {a['dirty_count']} |")

        # Issues
        issues = a.get("issues", [])
        if issues:
            if len(issues) == 1:
                iss = issues[0]
                print(f"| Issue | [#{iss['number']}]({iss['url']}) "
                      f"({iss['source']}) |")
            else:
                refs = ", ".join(
                    f"[#{i['number']}]({i['url']})" for i in issues[:5]
                )
                print(f"| Issues | {refs} |")

        # PR
        pr = a.get("pr")
        if pr:
            title_str = f" — {pr['title']}" if pr.get("title") else ""
            print(f"| PR | [#{pr['number']}]({pr['url']}){title_str} "
                  f"({pr['source']}) |")

        # Session stats
        if a.get("session"):
            s = a["session"]
            print(f"| Messages | {s['user_messages']} user / "
                  f"{s['assistant_messages']} assistant |")
            print(f"| Tool calls | {s['tool_calls']} |")
            if s["subagents"]:
                print(f"| Subagents | {s['subagents']} |")
            print(f"| Session size | {format_size(s['session_size'])} |")
            print(f"| Last activity | "
                  f"{s['last_modified'].strftime('%H:%M:%S')} |")
        print()

        # Prompt
        prompt = a.get("prompt")
        if prompt:
            print(f"**Prompt:** {trunc(prompt)}\n")

        # Latest output
        latest = a.get("latest_text")
        if latest:
            print(f"**Latest:** {trunc(latest)}\n")

        # Commits
        commits = a.get("commit_list", [])
        if commits:
            print("**Commits:**")
            for c in commits[:5]:
                print(f"- {c}")
            if len(commits) > 5:
                print(f"- ...+{len(commits) - 5} more")
            print()

        # Dirty files
        dirty = a.get("dirty_list", [])
        if dirty:
            print("**Dirty files:**")
            for f in dirty[:10]:
                print(f"- `{f.strip()}`")
            print()

        # Session path for follow-up
        if a.get("session"):
            print(f"<details><summary>Session file</summary>\n")
            print(f"`{a['session']['session_path']}`\n")
            print(f"</details>\n")

        print("---\n")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    json_mode = "--json" in sys.argv
    skip_session = "--no-session" in sys.argv
    skip_gh = "--no-gh" in sys.argv

    project_root = find_project_root()
    worktrees_dir = project_root / ".claude" / "worktrees"

    agents = get_running_agents()
    if not agents:
        if json_mode:
            print("[]")
        else:
            print("No running Claude agents found.")
        return

    results = []
    for agent in agents:
        wt_path = worktrees_dir / agent["worktree"]
        data = {
            "pid": agent["pid"],
            "worktree": agent["worktree"],
            "elapsed_seconds": agent["elapsed_seconds"],
            "elapsed_fmt": format_elapsed(agent["elapsed_seconds"]),
            "headless": agent["headless"],
            "skip_permissions": agent["skip_permissions"],
            "prompt": agent["cli_prompt"],
            "case_name": None,
            "branch": None,
            "new_commits": None,
            "dirty_count": None,
            "commit_list": [],
            "dirty_list": [],
            "latest_text": None,
            "session": None,
            "issues": [],
            "pr": None,
        }

        # Git info
        if wt_path.exists():
            git = get_git_info(wt_path)
            data["branch"] = git["branch"]
            data["new_commits"] = len(git["commits"])
            data["dirty_count"] = len(git["dirty"])
            data["commit_list"] = git["commits"]
            data["dirty_list"] = git["dirty"]

            # Lock / case info
            lock = read_lock_file(wt_path)
            if lock:
                data["case_name"] = lock.get("case_name")

        # Session parsing
        if not skip_session:
            session_file = find_session_file(agent["worktree"], project_root)
            if session_file:
                info = parse_session(session_file)
                data["session"] = info
                if not data["prompt"] and info["first_prompt"]:
                    data["prompt"] = info["first_prompt"]
                data["latest_text"] = info["latest_text"]

        # Issue & PR resolution
        if wt_path.exists():
            resolve_issues_and_prs(data, wt_path, skip_gh)

        results.append(data)

    if json_mode:
        output_json(results)
    else:
        output_markdown(results)


if __name__ == "__main__":
    main()
