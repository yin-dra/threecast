# shellcheck shell=bash
# threecast — MIT License
# Step 0: rent a server (Hetzner, DigitalOcean) or register your own over SSH.

# shellcheck source=provision/hetzner.sh
. "$TC_ROOT/provision/hetzner.sh"
# shellcheck source=provision/digitalocean.sh
. "$TC_ROOT/provision/digitalocean.sh"

UP_DEFAULT_DATA_DIR=/root/snapchain
UP_DEFAULT_VOLUME_GB=1000
UP_ROLLBACK=

up_usage() {
  cat <<'EOF'
Usage: ./threecast up [options]

Rents a server for your Farcaster node, or registers one you already have.
Without options it asks which one you want.

  --provider hetzner|digitalocean  rent by the hour (asks for an API token)
  --host user@ip                   use your own Ubuntu or Debian server over SSH
  --key PATH                       SSH key for --host (default: your SSH agent
                                   and the keys in ~/.ssh)
  --data-dir DIR                   where node data goes on --host
                                   (default /root/snapchain)
  --location L                     Hetzner: fsn1, nbg1, hel1 are tried in order;
                                   or ash, hil, sin, or any.
                                   DigitalOcean: fra1, ams3, lon1, nyc3, sfo3
                                   are tried in order; or any
  --public-api                     also open the node's HTTP API (3381/tcp) to
                                   the internet
  --name N                         name for this server (default: threecast)
  --yes                            do not ask before creating billable resources

Advanced:
  --server-type T                  Hetzner type (default: the first of cpx42,
                                   ccx23, cax31, cx43 that is for sale), or
                                   DigitalOcean size (default: s-8vcpu-16gb)
  --volume-size GB                 size of the data volume (default 1000)
EOF
}

cmd_up() {
  local provider='' host='' key='' data_dir='' location='' server_type='' volume_gb='' public_api=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --*=*) set -- "${1%%=*}" "${1#*=}" "${@:2}"; continue ;;
    esac
    case "$1" in
      --provider)    up_need_value "$@"; provider=$2; shift 2 ;;
      --host)        up_need_value "$@"; host=$2; shift 2 ;;
      --key)         up_need_value "$@"; key=$2; shift 2 ;;
      --data-dir)    up_need_value "$@"; data_dir=$2; shift 2 ;;
      --location)    up_need_value "$@"; location=$2; shift 2 ;;
      --server-type) up_need_value "$@"; server_type=$2; shift 2 ;;
      --volume-size) up_need_value "$@"; volume_gb=$2; shift 2 ;;
      --public-api)  public_api=1; shift ;;
      -h|--help)     up_usage; return 0 ;;
      *) die "Unknown option for up: $1" "See the options: ./threecast up --help" ;;
    esac
  done

  TC_TARGET=$(target_name)
  UP_NAME=$TC_TARGET
  valid_target_name "$UP_NAME"
  up_refuse_existing "$UP_NAME"

  [ -z "$provider" ] || [ -z "$host" ] || die "Use either --provider or --host, not both."
  if [ -z "$provider" ] && [ -z "$host" ]; then
    [ -t 0 ] && [ -t 1 ] || die "Tell threecast where the node should run:" \
      "./threecast up --provider hetzner        rent a Hetzner Cloud server (about €5/day)" \
      "./threecast up --provider digitalocean   rent a DigitalOcean Droplet (about \$7/day)" \
      "./threecast up --host root@203.0.113.7   use your own Ubuntu or Debian server"
    up_menu
    provider=$UP_CHOICE_PROVIDER
    host=$UP_CHOICE_HOST
  fi

  if [ -n "$host" ]; then
    [ -z "$location$server_type$volume_gb" ] || die "--location, --server-type and --volume-size are for rented servers, not --host."
    [ "$public_api" = 0 ] || warn "--public-api only changes the firewall of rented servers. On your own server, open 3381/tcp yourself if you want that."
    up_byo "$host" "$key" "${data_dir:-$UP_DEFAULT_DATA_DIR}"
    return
  fi

  [ -z "$key$data_dir" ] || die "--key and --data-dir are for your own server (--host)." \
    "Rented servers get a key made by threecast ($TC_HOME/ssh/id_ed25519) and their data on a volume at $UP_DEFAULT_DATA_DIR."
  volume_gb=${volume_gb:-$UP_DEFAULT_VOLUME_GB}
  up_check_volume_size "$volume_gb"
  case "$location" in ''|any) ;; *) up_check_word "--location" "$location" ;; esac
  [ -z "$server_type" ] || up_check_word "--server-type" "$server_type"
  need_cmd curl jq ssh ssh-keygen
  UP_PUBLIC_API=$public_api
  case "$provider" in
    hetzner)      hz_up "$UP_NAME" "$location" "$server_type" "$volume_gb" ;;
    digitalocean) do_up "$UP_NAME" "$location" "$server_type" "$volume_gb" ;;
    *) die "Unknown provider '$provider'." "Use --provider hetzner, --provider digitalocean, or --host user@ip for your own server." ;;
  esac
}

up_need_value() {
  [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value." "See the options: ./threecast up --help"
}

# Target names end up in hostnames, cloud labels, DigitalOcean volume names and file paths;
# this is the set all of them accept.
valid_target_name() {
  local re='^[a-z]([a-z0-9-]{0,38}[a-z0-9])?$'
  [[ $1 =~ $re ]] || die "'$1' cannot be used as a name." \
    "Use lowercase letters, digits and dashes, starting with a letter (at most 40), e.g. --name my-node"
}

up_check_word() {
  local re='^[a-z0-9-]+$'
  [[ $2 =~ $re ]] || die "$1 '$2' does not look like a provider value (lowercase letters, digits, dashes)."
}

up_check_volume_size() {
  case "$1" in ''|*[!0-9]*) die "--volume-size takes a whole number of GB, e.g. --volume-size 1000" ;; esac
  [ "$1" -ge 10 ] || die "--volume-size must be at least 10 GB."
  if [ "$1" -lt 700 ]; then
    warn "A $1 GB volume is too small for the current snapshot (about 556 GiB unpacked, growing daily)."
    confirm "Use $1 GB anyway?" || die "Stopped. Nothing was created."
  fi
}

up_refuse_existing() {
  target_exists "$1" || return 0
  local f provider host
  f=$(target_file "$1")
  provider=$(sed -n 's/^PROVIDER=//p' "$f")
  host=$(sed -n 's/^HOST=//p' "$f")
  die "A server named '$1' is already set up ($provider, $host)." \
    "Use it:          ./threecast node --name $1" \
    "Add another one: ./threecast up --name another-name" \
    "Remove it:       ./threecast down --name $1"
}

up_menu() {
  local choice
  UP_CHOICE_PROVIDER=''
  UP_CHOICE_HOST=''
  say "Where should your Farcaster node run? It needs 4+ CPU cores, 16 GB of RAM"
  say "and about 1000 GB of disk."
  say ""
  say "  1) Hetzner Cloud     about €5/day, the cheapest. New accounts may not be"
  say "                       allowed to create servers."
  say "  2) DigitalOcean      about \$7/day. New accounts must first raise their"
  say "                       resource tier."
  say "  3) Your own server   Ubuntu or Debian, 16 GB RAM, 700 GB free disk,"
  say "                       reachable over SSH."
  say ""
  hint "Rented servers bill by the hour until you run ./threecast down."
  printf 'Choose 1, 2 or 3: '
  read -r choice || choice=''
  case "$choice" in
    1) UP_CHOICE_PROVIDER=hetzner ;;
    2) UP_CHOICE_PROVIDER=digitalocean ;;
    3) printf 'SSH address of your server (user@ip): '
       read -r UP_CHOICE_HOST || UP_CHOICE_HOST=''
       [ -n "$UP_CHOICE_HOST" ] || die "No address entered." ;;
    *) die "Please answer 1, 2 or 3." ;;
  esac
}

# api_call METHOD URL TOKEN [JSON] — sets API_STATUS (000 when the API was unreachable), API_BODY
# and API_NETERR. Returns 0 on 2xx. The token reaches curl through a file descriptor, never argv,
# so it does not show up in `ps`.
api_call() {
  local method=$1 url=$2 token=$3 body=${4:-} out err
  out=$(mktemp "$TC_HOME/run/api.XXXXXX")
  err="$out.err"
  local args=(-sS -X "$method" -o "$out" -w '%{http_code}' --connect-timeout 10 --max-time 120
    -H 'Accept: application/json')
  if [ -n "$body" ]; then
    API_STATUS=$(curl "${args[@]}" -H @<(printf 'Authorization: Bearer %s\n' "$token") \
      -H 'Content-Type: application/json' --data-binary @- "$url" <<<"$body" 2>"$err") || true
  else
    API_STATUS=$(curl "${args[@]}" -H @<(printf 'Authorization: Bearer %s\n' "$token") "$url" 2>"$err") || true
  fi
  API_BODY=$(cat "$out")
  API_NETERR=$(head -n 1 "$err")
  rm -f "$out" "$err"
  case "$API_STATUS" in 2??) return 0 ;; ''|000) API_STATUS=000; return 1 ;; *) return 1 ;; esac
}

# Worth waiting and asking again: no answer, rate limited, or a server-side error.
api_transient() {
  case "$API_STATUS" in 000|429|5??) return 0 ;; *) return 1 ;; esac
}

# cloud_token VAR PROVIDER HOW_TO_CREATE — the API token from the environment, then
# $TC_HOME/credentials, then a hidden prompt. Sets VAR and CLOUD_TOKEN_SOURCE.
cloud_token() {
  local var=$1 provider=$2 how=$3 file="$TC_HOME/credentials" value
  value=${!var:-}
  CLOUD_TOKEN_SOURCE="the $var environment variable"
  CLOUD_TOKEN_NEW=0
  if [ -z "$value" ] && [ -f "$file" ]; then
    value=$(sed -n "s/^$var=//p" "$file" | tail -n 1)
    CLOUD_TOKEN_SOURCE=$file
  fi
  if [ -z "$value" ]; then
    [ -t 0 ] || die "No $provider API token found." \
      "Create one: $how" "Then: export $var=<token> and run this again."
    say "threecast needs a $provider API token to manage the server for you."
    hint "Create one: $how"
    ask_secret "Paste the token (nothing is shown while you type):" value
    [ -n "$value" ] || die "No token entered."
    CLOUD_TOKEN_SOURCE="what you pasted"
    CLOUD_TOKEN_NEW=1
  fi
  printf -v "$var" '%s' "$value"
}

# Offered only after the provider accepted the token, so a typo is never saved.
cloud_token_offer_save() {
  local var=$1 file="$TC_HOME/credentials" tmp
  [ "$CLOUD_TOKEN_NEW" = 1 ] || return 0
  CLOUD_TOKEN_NEW=0
  [ "$TC_YES" != 1 ] || return 0
  confirm "Save the token in $file (only you can read it) so you are not asked again?" || return 0
  tmp=$(mktemp "$TC_HOME/credentials.XXXXXX")
  if [ -f "$file" ]; then grep -v "^$var=" "$file" > "$tmp" || true; fi
  printf '%s=%s\n' "$var" "${!var}" >> "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$file"
  ok "Saved. Delete $file to make threecast forget it."
}

# The SSH key threecast puts on servers it rents. Sets UP_KEY and UP_KEY_FP (MD5, as both APIs want).
up_local_key() {
  UP_KEY="$TC_HOME/ssh/id_ed25519"
  if [ ! -f "$UP_KEY" ]; then
    step "Creating an SSH key for your threecast servers ($UP_KEY)…"
    ssh-keygen -q -t ed25519 -N '' -C threecast -f "$UP_KEY"
  fi
  UP_KEY_FP=$(ssh-keygen -E md5 -lf "$UP_KEY.pub" | awk '{print $2}')
  UP_KEY_FP=${UP_KEY_FP#MD5:}
}

# cloud_init_for DEVICE — the first-boot config, with the volume's device path filled in.
cloud_init_for() {
  local re='^/dev/disk/by-id/[A-Za-z0-9_.-]+$'
  [[ $1 =~ $re ]] || die "The provider returned an unexpected volume device path: $1"
  sed "s|__VOLUME_DEVICE__|$1|" "$TC_ROOT/provision/cloud-init.yaml"
}

# cost_hourly SERVER_H IPV4_H VOLUME_GB VOLUME_GB_MONTH HOURS_PER_MONTH
cost_hourly() {
  LC_ALL=C awk -v s="$1" -v i="$2" -v g="$3" -v m="$4" -v h="$5" 'BEGIN { printf "%.4f\n", s + i + g * m / h }'
}

# show_cost CURRENCY SERVER_LABEL SERVER_H SERVER_M IPV4_H IPV4_M VOLUME_LABEL VOLUME_GB VOLUME_GB_MONTH HOURS_PER_MONTH
# IPV4_H 0 means the address is included in the server price. The table fits 80 columns.
show_cost() {
  LC_ALL=C awk -v c="$1" -v server="$2" -v sh="$3" -v sm="$4" -v ih="$5" -v im="$6" \
    -v volume="$7" -v gb="$8" -v gbm="$9" -v hours="${10}" '
    # "≈" is three bytes but one column wide, hence the wider field for estimates.
    function hourly(x, estimate) {
      return estimate ? sprintf("%11s", "≈" sprintf("%.4f", x)) : sprintf("%9.4f", x)
    }
    BEGIN {
      vm = gb * gbm; vh = vm / hours; total = sh + ih + vh
      head = "Prices in " c ", before VAT"
      w = length(head)
      if (length(server) > w) w = length(server)
      if (length(volume) > w) w = length(volume)
      fmt = "    %-" w "s  %s   %s\n"
      printf fmt, head, sprintf("%9s", "per hour"), "per month"
      printf fmt, server, hourly(sh, 0), sprintf("at most %.2f", sm)
      if (ih > 0) printf fmt, "Public IPv4 address", hourly(ih, 0), sprintf("at most %.2f", im)
      else        printf "    %-" w "s  %9s\n", "Public IPv4 address", "included"
      printf fmt, volume, hourly(vh, 1), sprintf("%.2f", vm)
      printf fmt, "Total", hourly(total, 1), sprintf("≈%.2f", sm + im + vm)
      printf "  About %.2f %s a day. Billing runs until you run ./threecast down.\n", total * 24, c
    }'
  say "  A stopped server still bills."
}

# From the first billable resource until the target is saved, any exit (an error, Ctrl-C,
# a closed terminal, output piped to a reader that went away) runs ROLLBACK_FN, which deletes
# what this run created. A signal left at its default would end bash without the EXIT trap.
up_begin_creating() { # ROLLBACK_FN
  UP_CREATED_AT=$(date +%s)
  UP_ROLLBACK=$1
  trap 'up_on_exit $?' EXIT
  trap 'exit 130' INT
  trap 'exit 141' PIPE
  trap 'exit 143' TERM HUP
}

up_disarm_rollback() {
  UP_ROLLBACK=
  trap - EXIT INT PIPE TERM HUP
}

up_on_exit() {
  [ "$1" != 0 ] && [ -n "$UP_ROLLBACK" ] || return 0
  trap '' INT PIPE TERM HUP
  set +e
  # With the terminal (or the pipe it was read through) gone, messages fail to print, and
  # bash 3.2 then hands the unprinted text to the next command's output: here, the API calls.
  # So the rollback carries on silently instead.
  if ! printf '\n' 2>/dev/null ||
    ! warn "Setup did not finish. Deleting what this run created so nothing keeps billing (please wait)…"; then
    exec >/dev/null 2>&1
    printf '\n'
  fi
  "$UP_ROLLBACK"
  UP_ROLLBACK=
  # An interruption while the target was being written leaves a file that names deleted
  # resources. up_refuse_existing made sure no earlier file had this name.
  rm -f "$(target_file "$UP_NAME")"
  if [ -f "$TC_HOME/current" ] && [ "$(cat "$TC_HOME/current")" = "$UP_NAME" ]; then rm -f "$TC_HOME/current"; fi
}

up_rented_login() {
  SSH_USER=root
  SSH_KEY=$UP_KEY
  DATA_DIR=$UP_DEFAULT_DATA_DIR
}

# Waits until the new server answers SSH, cloud-init is done and the volume is mounted.
up_wait_ready() {
  if [ "${THREECAST_TEST_SKIP_REMOTE:-0}" = 1 ]; then
    warn "THREECAST_TEST_SKIP_REMOTE=1: skipping the SSH, cloud-init and volume checks (tests only)."
    return 0
  fi
  # Providers reuse IP addresses; an old host key for this IP would make ssh refuse.
  ssh-keygen -R "$HOST" -f "$TC_HOME/known_hosts" >/dev/null 2>&1 || true
  step "Waiting for the server to accept SSH at $SSH_USER@$HOST (it is booting)…"
  local start=$SECONDS reachable=0 rc=0
  while [ $((SECONDS - start)) -lt 300 ]; do
    if ssh_node true 2>/dev/null; then reachable=1; break; fi
    sleep 5
  done
  [ "$reachable" = 1 ] || die "The server did not accept SSH within 5 minutes." \
    "Check that your network allows outgoing SSH (port 22), then run ./threecast up again."
  ok "SSH works (host key saved in $TC_HOME/known_hosts)."

  step "Waiting for first-boot setup: packages, and mounting the volume at $DATA_DIR (cloud-init)…"
  ssh_node 'cloud-init status --wait >/dev/null' || rc=$?
  [ "$rc" != 255 ] || die "Lost the SSH connection to $HOST while waiting for first-boot setup." \
    "Check your network, then run ./threecast up again."
  # The mount is what node.sh cannot do without; a failed package step it repairs itself
  # (node.sh installs curl, jq and cron when they are missing).
  if [ "$rc" != 0 ]; then
    warn "First-boot setup reported problems (cloud-init exit code $rc). Its last log lines:"
    ssh_node 'tail -n 20 /var/log/cloud-init-output.log' >&2 || true
  fi
  ssh_node "mountpoint -q $DATA_DIR" || die "The data volume is not mounted at $DATA_DIR." \
    "Look at /var/log/cloud-init-output.log on the server for the reason."
  ok "Volume mounted:"
  ssh_node "df -h $DATA_DIR"
}

# up_save_target PROVIDER — the keys every rented target has; the caller adds its provider ids.
up_save_target() {
  rm -f "$(target_file "$UP_NAME")"
  target_set NAME "$UP_NAME"
  target_set PROVIDER "$1"
  target_set HOST "$HOST"
  target_set SSH_USER "$SSH_USER"
  target_set SSH_KEY "$SSH_KEY"
  target_set DATA_DIR "$DATA_DIR"
  target_set CREATED_AT "$UP_CREATED_AT"
  target_set TUNNEL_PORT "$TUNNEL_DEFAULT_PORT"
  target_set PUBLIC_API "${UP_PUBLIC_API:-0}"
  printf '%s\n' "$UP_NAME" > "$TC_HOME/current"
}

up_print_next() {
  say ""
  say "Next: ./threecast node"
  hint "Restores the public Snapchain snapshot (about 506 GB to download) and starts"
  hint "your read node. It runs on the server, so you can close your laptop."
  hint "Our first run took 10 h 10 min to sync. Start it in the evening: synced by morning."
}

# up_byo USER@HOST KEY DATA_DIR — checks a server the user already has and saves it as a target.
up_byo() {
  local address=$1 key=$2 dir=$3 facts os arch mem_kib cpus root sudo free_kib free_gib
  need_cmd ssh
  case "$address" in
    *@*) SSH_USER=${address%@*}; HOST=${address#*@} ;;
    *)   SSH_USER=root; HOST=$address; hint "No user given, so threecast logs in as root@$HOST." ;;
  esac
  local re='^[A-Za-z0-9._:-]+$'
  [[ $HOST =~ $re ]] && [[ $SSH_USER =~ $re ]] || die "'$address' does not look like user@host." \
    "Example: ./threecast up --host root@203.0.113.7"
  SSH_KEY=''
  if [ -n "$key" ]; then
    [ -f "$key" ] || die "No SSH key at $key."
    SSH_KEY=$(cd "$(dirname "$key")" && pwd)/$(basename "$key")
  fi
  re='^/[A-Za-z0-9._/-]*[A-Za-z0-9._-]$'
  [[ $dir =~ $re ]] && [[ $dir != *..* ]] || die "--data-dir must be an absolute path such as /root/snapchain."
  DATA_DIR=$dir

  step "Logging in to $SSH_USER@$HOST over SSH to check the machine…"
  facts=$(up_byo_facts_script | ssh_node sh -s "$DATA_DIR") || die "Could not log in to $SSH_USER@$HOST over SSH." \
    "threecast needs a login that works without typing a password: ssh $SSH_USER@$HOST true" \
    "Set that up with: ssh-copy-id $SSH_USER@$HOST   or pick a key: --key ~/.ssh/id_ed25519"

  os=$(up_fact os "$facts"); arch=$(up_fact arch "$facts")
  mem_kib=$(up_number "$(up_fact mem_kib "$facts")"); cpus=$(up_number "$(up_fact cpus "$facts")")
  root=$(up_fact root "$facts"); sudo=$(up_fact sudo "$facts")
  free_kib=$(up_number "$(up_fact free_kib "$facts")")

  case "$os" in ubuntu|debian) ;; *)
    die "threecast supports Ubuntu and Debian servers; this one runs $(up_fact os_name "$facts")." ;;
  esac
  case "$arch" in x86_64|aarch64) ;; *)
    die "Snapchain publishes images for x86_64 and aarch64; this server is $arch." ;;
  esac
  # A 16 GB machine reports a little under 16 GiB once the kernel takes its share.
  [ "$mem_kib" -ge $((15 * 1024 * 1024)) ] || die "Snapchain needs 16 GB of RAM; this server has $((mem_kib / 1024 / 1024)) GiB."
  [ "$cpus" -ge 4 ] || die "Snapchain needs at least 4 CPU cores; this server has $cpus."
  [ "$(up_fact systemd "$facts")" = yes ] || die "This server does not run systemd." \
    "threecast runs the node setup as a systemd service, so that it survives your SSH session ending." \
    "Use a regular VM (most cloud servers are), not a container."
  SUDO=''
  if [ "$root" != yes ]; then
    [ "$sudo" = yes ] || die "threecast needs root on the server, or a user with passwordless sudo." \
      "Log in as root:  ./threecast up --host root@$HOST" \
      "Or, on the server: echo '$SSH_USER ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/threecast"
    SUDO=sudo
  fi
  free_gib=$((free_kib / 1024 / 1024))
  if [ "$free_gib" -lt 700 ]; then
    warn "Only $free_gib GiB free at $DATA_DIR. The snapshot unpacks to about 556 GiB and grows every day,"
    warn "so with less than 700 GiB the restore can run out of space part-way."
    confirm "Use this server anyway?" || die "Stopped. Nothing was saved." \
      "Free up space, or point at a bigger disk with --data-dir /mnt/bigdisk/snapchain"
  fi
  local login='as root'
  [ -z "$SUDO" ] || login='with passwordless sudo'
  ok "$(up_fact os_name "$facts"), $arch, $cpus CPUs, $((mem_kib / 1024 / 1024)) GiB RAM, $free_gib GiB free at $DATA_DIR, logged in $login."

  UP_CREATED_AT=$(date +%s)
  UP_PUBLIC_API=0
  up_save_target byo
  [ -z "$SUDO" ] || target_set SUDO "$SUDO"
  ok "Saved as '$UP_NAME' in $(target_file "$UP_NAME")."
  say ""
  warn "Your firewall: allow 3382/udp inbound (Snapchain gossip), so other nodes can reach yours."
  warn "Keep 3000 (Grafana, password admin/admin), 8125/udp and 8126/tcp (statsd), 3381 and 3383 closed to the internet."
  hint "Docker publishes those ports on every interface and bypasses ufw, so block them in your provider's"
  hint "or router's firewall. threecast reaches the node through an SSH tunnel, so it never needs them open."
  up_print_next
}

# Runs on the user's server under plain sh (any login shell). $1 is the data directory.
# Prints key=value lines; up_fact reads them.
up_byo_facts_script() {
  cat <<'EOF'
dir=$1
if [ "$(id -u)" = 0 ]; then echo root=yes; as_root=''; else echo root=no; as_root='sudo -n'; fi
if sudo -n true 2>/dev/null; then echo sudo=yes; else echo sudo=no; fi
[ -r /etc/os-release ] && . /etc/os-release
echo "os=${ID:-unknown}"
echo "os_name=${PRETTY_NAME:-unknown}"
echo "arch=$(uname -m)"
echo "mem_kib=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)"
echo "cpus=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN)"
if [ -d /run/systemd/system ] && command -v systemd-run >/dev/null 2>&1; then echo systemd=yes; else echo systemd=no; fi
p=$dir
while [ "$p" != / ] && ! $as_root test -d "$p" 2>/dev/null; do p=$(dirname "$p"); done
echo "free_kib=$($as_root df -Pk "$p" 2>/dev/null | awk 'NR == 2 { print $4 }')"
EOF
}

# up_fact KEY FACTS — one value from the key=value lines above.
up_fact() {
  awk -v k="$1" 'index($0, k "=") == 1 { print substr($0, length(k) + 2); exit }' <<<"$2"
}

up_number() {
  case "$1" in ''|*[!0-9]*) printf '0\n' ;; *) printf '%s\n' "$1" ;; esac
}
