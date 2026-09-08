#!/usr/bin/env bash
# A wizard: walks a human through the steps only they can take.
#
# Everything above the STAGES marker is the shared library and is identical in
# every wizard the `wizard` skill generates. Do not hand-edit it: a reviewer
# reads the stages and trusts the machinery, which only works while the
# machinery is the same everywhere.
#
# Author your stages below the marker, set TOTAL_STAGES, and delete the example.
set -uo pipefail

TOTAL_STAGES=0          # set this to the number of stages you write
CURRENT_STAGE=0
ENV_FILE="${ENV_FILE:-.env}"
CAPTURED=()             # "KEY=where it went", for the closing summary

# ── Presentation ────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RESET=$'\033[0m'
  BLUE=$'\033[34m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'
else
  BOLD=''; DIM=''; RESET=''; BLUE=''; GREEN=''; YELLOW=''; RED=''
fi

_clear() { [ -t 1 ] && printf '\033[2J\033[H' || true; }

banner() {
  printf '%s%s%s\n' "$BOLD" "$1" "$RESET"
  printf '%s%s%s\n\n' "$DIM" "$(printf '%0.s─' $(seq 1 ${#1}))" "$RESET"
}

# One screen per stage. Anything the human needs must fit on it.
stage() {
  CURRENT_STAGE=$((CURRENT_STAGE + 1))
  _clear
  printf '%s[%d/%d]%s %s%s%s\n\n' \
    "$DIM" "$CURRENT_STAGE" "$TOTAL_STAGES" "$RESET" "$BOLD" "$1" "$RESET"
}

say()  { printf '  %s\n' "$1"; }
step() { printf '  %s>%s %s\n' "$BLUE" "$RESET" "$1"; }
note() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
warn() { printf '  %s! %s%s\n' "$YELLOW" "$1" "$RESET"; }
ok()   { printf '  %s+%s %s\n' "$GREEN" "$RESET" "$1"; }
fail() { printf '  %sx %s%s\n' "$RED" "$1" "$RESET"; }

# ── Browser ─────────────────────────────────────────────────────────────────
# Always open the URL before asking for the value it produces.
open_url() {
  local url="$1"
  step "Opening: $url"
  if   command -v open        >/dev/null 2>&1; then open "$url" >/dev/null 2>&1 &
  elif command -v wslview     >/dev/null 2>&1; then wslview "$url" >/dev/null 2>&1 &
  elif command -v xdg-open    >/dev/null 2>&1; then xdg-open "$url" >/dev/null 2>&1 &
  elif command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile Start-Process "$url" >/dev/null 2>&1 &
  else
    note "could not open a browser here, visit it by hand"
  fi
  sleep 1
}

# ── Gates ───────────────────────────────────────────────────────────────────
pause() { printf '\n  %sPress enter when done.%s ' "$DIM" "$RESET"; read -r _; }

# Use before anything irreversible. Name what is about to happen: a bare
# "Continue?" gets a reflexive yes.
confirm() {
  local ans
  printf '\n  %s%s%s [y/N] ' "$YELLOW" "$1" "$RESET"
  read -r ans
  case "$ans" in [yY]|[yY][eE][sS]) return 0 ;; *) fail "stopped"; exit 1 ;; esac
}

# ── Capture ─────────────────────────────────────────────────────────────────
# A value already in .env is offered as the default, so re-running the wizard
# to fix one stage does not mean retyping every earlier one.
_existing() {
  [ -f "$ENV_FILE" ] || return 1
  local line; line=$(grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null) || return 1
  printf '%s' "${line#*=}" | sed 's/^"//; s/"$//'
}

ask() {
  local key="$1" prompt="$2" cur val
  cur=$(_existing "$key") || cur=''
  if [ -n "$cur" ]; then
    printf '\n  %s [%s]: ' "$prompt" "$cur"
  else
    printf '\n  %s: ' "$prompt"
  fi
  read -r val
  [ -z "$val" ] && val="$cur"
  [ -z "$val" ] && { fail "$key is required"; exit 1; }
  printf -v "$key" '%s' "$val"
  export "${key?}"
}

# Never echoes. Use for anything that must not survive in scrollback.
ask_secret() {
  local key="$1" prompt="$2" cur val
  cur=$(_existing "$key") || cur=''
  if [ -n "$cur" ]; then
    printf '\n  %s [keep existing]: ' "$prompt"
  else
    printf '\n  %s: ' "$prompt"
  fi
  read -rs val; printf '\n'
  [ -z "$val" ] && val="$cur"
  [ -z "$val" ] && { fail "$key is required"; exit 1; }
  printf -v "$key" '%s' "$val"
  export "${key?}"
}

# ── Persistence ─────────────────────────────────────────────────────────────
# Idempotent: re-running replaces the line rather than appending a second one,
# which is the bug that makes a half-finished wizard run unrecoverable.
write_env() {
  local key="$1" val="$2"
  touch "$ENV_FILE"
  if grep -q "^$key=" "$ENV_FILE" 2>/dev/null; then
    local tmp; tmp=$(mktemp)
    grep -v "^$key=" "$ENV_FILE" > "$tmp" && mv "$tmp" "$ENV_FILE"
  fi
  printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  CAPTURED+=("$key -> $ENV_FILE")
  ok "$key written to $ENV_FILE"
}

# The name must match a secrets.* reference in CI exactly. CI reports a
# mismatched name as an empty string, never as an error.
set_secret() {
  local key="$1" val="$2"
  command -v gh >/dev/null 2>&1 || { warn "gh not installed, skipping secret $key"; return 0; }
  if printf '%s' "$val" | gh secret set "$key" --body-file - 2>/dev/null; then
    CAPTURED+=("$key -> GitHub secret")
    ok "$key set as a GitHub secret"
  else
    fail "could not set GitHub secret $key (is gh authenticated for this repo?)"
  fi
}

set_var() {
  local key="$1" val="$2"
  command -v gh >/dev/null 2>&1 || { warn "gh not installed, skipping variable $key"; return 0; }
  if gh variable set "$key" --body "$val" >/dev/null 2>&1; then
    CAPTURED+=("$key -> GitHub variable")
    ok "$key set as a GitHub variable"
  else
    fail "could not set GitHub variable $key"
  fi
}

# ── Close ───────────────────────────────────────────────────────────────────
finish() {
  _clear
  banner "Done"
  if [ ${#CAPTURED[@]} -gt 0 ]; then
    say "Captured:"
    for entry in "${CAPTURED[@]}"; do note "  $entry"; done
    printf '\n'
  fi
  [ $# -gt 0 ] && { say "$1"; printf '\n'; }
  if [ "$CURRENT_STAGE" -ne "$TOTAL_STAGES" ]; then
    warn "ran $CURRENT_STAGE of $TOTAL_STAGES stages: TOTAL_STAGES is wrong, or a stage was skipped"
  fi
}

# ---- STAGES ----------------------------------------------------------------
# Bouquin: obtain a Reddit Data API app and hand its credentials to the Convex
# deployment, so ingest.scan reads Reddit directly instead of the archive.
#
# Run from projects/bouquin-site:   bash scripts/setup-reddit.sh
# Re-run any time: captured values are offered back as defaults.
#
# Why a person has to do this (2026-09-08): Reddit closed self-service API
# registration on 2025-11-11 and now approves each new app by hand, and it
# asks that every existing app be registered by 2026-09-30. Every stage below
# is a logged-in Reddit page or a support form. The site keeps working on the
# Arctic Shift archive until this succeeds, so nothing here is urgent for the
# site; it is urgent only for an app you already own.
#
# Menu paths marked (unverified) come from Reddit's help centre and r/redditdev
# reports, not from a run of this script: say so if the page differs.

TOTAL_STAGES=6
cd "$(dirname "$0")/.." || exit 1
[ -d convex ] || { fail "run this from projects/bouquin-site (convex/ not found)"; exit 1; }

_clear
banner "Bouquin: Reddit Data API credentials"
say "Six stages. The first decides which path you are on: an app that already"
say "exists at reddit.com/prefs/apps (fast), or a new access request (slow)."
say "The id and User-Agent go to $ENV_FILE (gitignored) as re-run defaults;"
say "the secret goes to the Convex deployment only."
printf '\n'
note "Nothing is sent anywhere until stage 5 asks you to confirm."
pause

# ── 1. Which path ────────────────────────────────────────────────────────────
stage "Check whether a Reddit app already exists"
say "Log in with the Reddit account that will own the app, then look at the"
say "'developed applications' list. Each app shows its name, its type (script,"
say "web app, installed app) and a short client id under the name."
open_url "https://www.reddit.com/prefs/apps"
step "If an app of type 'script' or 'web app' is listed, click 'edit' on it and"
step "keep that tab open: stage 3 needs its client id and its 'secret'."
step "If the list is empty, try the form at the bottom once: 'create another app',"
step "name Bouquin, type script, redirect uri http://localhost:8883/ (unverified:"
step "r/redditdev has reported this form resetting silently since July 2026)."
printf '\n'
ask REDDIT_HAS_APP "Do you have an app with a client id and secret now? (yes/no)"
case "$REDDIT_HAS_APP" in
  [yY]*) HAS_APP=1 ;;
  *) HAS_APP=0 ;;
esac

# ── 2. Register or request ───────────────────────────────────────────────────
if [ "$HAS_APP" = 1 ]; then
  stage "Register the app with Reddit (deadline 2026-09-30)"
  say "Reddit's 2026-08-05 admin post asks that every existing API app be"
  say "registered on the Developer Platform 'to remain in good standing'."
  open_url "https://developers.reddit.com/app-registration"
  step "Sign in with the same account, then describe the app: personal,"
  step "non-commercial, read-only, a mirror of book suggestions from"
  step "r/suggestmeabook, roughly 60 requests per hour. (form fields unverified)"
  note "If the page reports the app as already registered, nothing to do here."
  pause
else
  stage "Request Data API access (the slow path)"
  say "With no app to reuse, the only sanctioned route is Reddit's request form."
  say "r/redditdev regulars report weeks of silence for personal read-only asks,"
  say "so expect to come back to this wizard later rather than finish it today."
  open_url "https://support.reddithelp.com/hc/en-us/requests/new?ticket_form_id=14868593862164"
  step "Category: non-commercial / personal use. Describe the app as above:"
  step "read-only, one subreddit, about 60 requests per hour, no user data."
  step "Ask for a 'script' type OAuth app and mention the redirect uri is unused."
  printf '\n'
  warn "The site does not need this to run: ingest.scan reads the Arctic Shift"
  warn "archive until REDDIT_* env vars exist on the deployment."
  pause
  ask REDDIT_HAS_APP "Did that produce a client id and secret already? (yes/no)"
  case "$REDDIT_HAS_APP" in
    [yY]*) HAS_APP=1 ;;
    *)
      finish "Request filed. Re-run this wizard when Reddit answers; the archive path stays active meanwhile. Record the request date in echeance (entry reddit-data-api-app) so the follow-up has a date."
      exit 0 ;;
  esac
fi

# ── 3. Client id ─────────────────────────────────────────────────────────────
stage "Copy the client id"
say "On the app's edit view the client id is the short string printed directly"
say "under the app's name (no label). It is 14 to 30 characters, no spaces."
ask REDDIT_CLIENT_ID "Client id"
case "$REDDIT_CLIENT_ID" in
  *" "*) fail "a client id has no spaces; you may have copied the label"; exit 1 ;;
esac
if [ ${#REDDIT_CLIENT_ID} -lt 10 ]; then fail "that is too short to be a client id"; exit 1; fi
write_env REDDIT_CLIENT_ID "$REDDIT_CLIENT_ID"

# ── 4. Secret ────────────────────────────────────────────────────────────────
stage "Copy the secret"
say "Same view, the field labelled 'secret'. It is not shown again after you"
say "leave the page; if it is hidden, the edit view has a reveal control."
ask_secret REDDIT_CLIENT_SECRET "Secret (hidden as you type)"
if [ ${#REDDIT_CLIENT_SECRET} -lt 16 ]; then fail "that is too short to be an app secret"; exit 1; fi
# The secret is not written to .env: it lives on the Convex deployment only,
# so a re-run of this wizard asks for it again. The id and the User-Agent are
# kept as re-run defaults; neither is sensitive on its own.
note "kept in memory only; it goes to Convex in stage 5 and nowhere else on this machine"

# ── 5. User-Agent and the deployment ─────────────────────────────────────────
stage "Set the User-Agent and push all three to Convex"
say "Reddit blocks generic User-Agents and asks for the form"
say "  platform:app-id:version (by /u/username)"
say "The username is the account that owns the app."
ask REDDIT_USERNAME "Reddit username (without u/)"
REDDIT_USERNAME="${REDDIT_USERNAME#u/}"
REDDIT_USER_AGENT="web:com.neorgon.bouquin:v1.0 (by /u/${REDDIT_USERNAME})"
write_env REDDIT_USER_AGENT "$REDDIT_USER_AGENT"
printf '\n'
say "Target deployment: the cron that matters runs on production. The dev"
say "deployment (npx convex dev) can take the same values for local testing."
ask CONVEX_TARGET "Write to which deployment? (prod/dev/both)"
CONVEX_TARGET=$(printf '%s' "$CONVEX_TARGET" | tr '[:upper:]' '[:lower:]')
case "$CONVEX_TARGET" in
  prod|dev|both) ;;
  *) fail "answer prod, dev or both (got '$CONVEX_TARGET'); nothing was written"; exit 1 ;;
esac
# Each variable is set on its own and every failure is collected, so a half
# credential (id landed, secret did not) is reported rather than passed over.
# The values travel in argv to the CLI, which is visible in `ps` for the
# moment the command runs; acceptable on a personal machine, not on a shared one.
push_env() {
  local flag="$1" label="$2" failed=""
  for key in REDDIT_CLIENT_ID REDDIT_CLIENT_SECRET REDDIT_USER_AGENT; do
    # shellcheck disable=SC2086
    if ! npx convex env set $flag "$key" "${!key}" >/dev/null 2>&1; then failed="$failed $key"; fi
  done
  if [ -n "$failed" ]; then
    fail "npx convex env set failed on $label for:$failed (is the CLI logged in? see echeance: convex-cli)"
    exit 1
  fi
  CAPTURED+=("REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USER_AGENT -> Convex $label")
  ok "env vars set on $label"
}
case "$CONVEX_TARGET" in
  prod|both)
    confirm "Write the three REDDIT_* env vars to the PRODUCTION deployment? The next cron run switches from the archive to Reddit."
    push_env "--prod" "production" ;;
esac
case "$CONVEX_TARGET" in
  dev|both) push_env "" "dev" ;;
esac

# ── 6. Verify ────────────────────────────────────────────────────────────────
stage "Verify with one scan"
say "ingest.scan reports which source it used. Success is status ok and"
say "source reddit; a 401 from the token endpoint means the id or secret is"
say "wrong, a 403 with a valid token usually means the User-Agent."
case "$CONVEX_TARGET" in
  prod|both) step "npx convex run ingest:scan --prod '{\"maxThreads\": 3}'"; npx convex run ingest:scan --prod '{"maxThreads": 3}' ;;
  *)         step "npx convex run ingest:scan '{\"maxThreads\": 3}'";        npx convex run ingest:scan '{"maxThreads": 3}' ;;
esac
printf '\n'
note "Open the site: the stats line under the hero names the source of the last scan."
pause

finish "Now record the credential in echeance (inventory entry reddit-data-api-app, kind api-key, expires never, note the registration date), so the 2026-09-30 registration deadline and any future revocation have a home."
