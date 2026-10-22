# shellcheck shell=bash
# threecast — MIT License
# DigitalOcean for `up` and `down` (API reference: https://docs.digitalocean.com/reference/api/).
# Droplets and volumes carry the tag threecast:<name>. Firewalls and SSH keys cannot be tagged,
# so they are named threecast-<name>; `down` finds them by that name.

DO_API=${DO_API:-https://api.digitalocean.com}
DO_SIZE=s-8vcpu-16gb
DO_REGIONS="fra1 ams3 lon1 nyc3 sfo3"
DO_IMAGE=ubuntu-24-04-x64
# The API has no volume prices. $0.10 per GiB per month, billed hourly:
# https://docs.digitalocean.com/products/volumes/details/pricing/
DO_VOLUME_GIB_MONTH=0.10
# No hourly volume rate is published either; DigitalOcean's billing month for Droplets is
# 672 hours, so monthly/672 is the upper estimate per hour.
DO_HOURS_PER_MONTH=672
DO_TOKEN_HELP="DigitalOcean Control Panel → API → Tokens → Generate New Token (Full Access)"

do_api() { api_call "$1" "$DO_API$2" "$DIGITALOCEAN_TOKEN" "${3:-}"; }

do_message() { jq -r '.message // empty' <<<"$API_BODY" 2>/dev/null || true; }

do_error() {
  if [ "$API_STATUS" = 000 ]; then
    printf 'no answer from %s (%s)' "$DO_API" "$API_NETERR"
  else
    printf '%s %s' "$API_STATUS" "$(jq -r '"\(.id): \(.message)"' <<<"$API_BODY" 2>/dev/null || printf 'unexpected reply')"
  fi
}

do_fail() { # "what threecast was doing"
  case "$API_STATUS" in
    401) die "DigitalOcean rejected the API token (401). It came from $CLOUD_TOKEN_SOURCE." \
           "Create a new one: $DO_TOKEN_HELP" ;;
    403) die "DigitalOcean did not allow threecast to $1 ($(do_error))." \
           "The token needs write access. Create a Full Access one: $DO_TOKEN_HELP" ;;
  esac
  die "DigitalOcean could not $1: $(do_error)" "Try again in a few minutes. DigitalOcean status: https://status.digitalocean.com"
}

do_must() { # "what" METHOD PATH [JSON]
  local what=$1
  shift
  do_api "$@" || do_fail "$what"
}

# New teams start at a low resource tier, and DigitalOcean answers with a limit error.
do_limit_hit() {
  case "$API_STATUS" in 403|422) grep -qiE 'limit|exceed|quota|tier' <<<"$(do_message)" ;; *) return 1 ;; esac
}

do_unavailable() {
  [ "$API_STATUS" = 422 ] && grep -qiE 'not available|unavailable|capacity|region' <<<"$(do_message)"
}

do_die_tier() { # "what was refused"
  die "DigitalOcean refused the $1 ($(do_error))." \
    "New DigitalOcean teams start at a low resource tier: Droplets up to \$48/month and 100 GiB per volume." \
    "threecast needs a \$96/month Droplet and a 1000 GiB volume, which tier 3 allows." \
    "Raise it: Control Panel → Resource Limits. A one-time prepayment raises the tier at once, or click Request an increase." \
    "Or: ./threecast up --provider hetzner, or your own server: ./threecast up --host root@IP"
}

# do_wait_action ID — sets DO_ACTION_ERROR when it fails.
do_wait_action() {
  local start=$SECONDS
  DO_ACTION_ERROR=
  while [ $((SECONDS - start)) -lt 600 ]; do
    if do_api GET "/v2/actions/$1"; then
      case "$(jq -r '.action.status' <<<"$API_BODY")" in
        completed) return 0 ;;
        errored) DO_ACTION_ERROR="action $1 ($(jq -r '.action.type' <<<"$API_BODY")) errored"; return 1 ;;
      esac
    elif ! api_transient; then
      DO_ACTION_ERROR=$(do_error)
      return 1
    fi
    sleep 3
  done
  DO_ACTION_ERROR="action $1 still running after 10 minutes"
  return 1
}

# do_candidates SIZE REGIONS — regions, in order, that sell SIZE and offer volumes ("storage").
do_candidates() {
  local sells storage region seen=' '
  sells=" $(jq -r --arg s "$1" '[.sizes[] | select(.slug == $s and .available) | .regions[]] | join(" ")' <<<"$DO_SIZES") "
  storage=" $(jq -r '[.regions[] | select(.available and any(.features[]; . == "storage")) | .slug] | join(" ")' <<<"$DO_REGION_LIST") "
  for region in $2; do
    case "$seen" in *" $region "*) continue ;; esac
    seen="$seen$region "
    case "$sells" in *" $region "*) ;; *) continue ;; esac
    case "$storage" in *" $region "*) printf '%s\n' "$region" ;; esac
  done
}

do_show_cost() { # SIZE REGION VOLUME_GB
  local hourly monthly spec
  hourly=$(jq -r --arg s "$1" '.sizes[] | select(.slug == $s) | .price_hourly' <<<"$DO_SIZES")
  monthly=$(jq -r --arg s "$1" '.sizes[] | select(.slug == $s) | .price_monthly' <<<"$DO_SIZES")
  spec=$(jq -r --arg s "$1" '.sizes[] | select(.slug == $s) | "\(.vcpus) vCPU, \(.memory / 1024) GB RAM"' <<<"$DO_SIZES")
  show_cost USD "Droplet $1 in $2 ($spec)" "$hourly" "$monthly" 0 0 \
    "Volume, $3 GiB for the database" "$3" "$DO_VOLUME_GIB_MONTH" "$DO_HOURS_PER_MONTH"
  UP_PRICE_HOURLY=$(cost_hourly "$hourly" 0 "$3" "$DO_VOLUME_GIB_MONTH" "$DO_HOURS_PER_MONTH")
  UP_PRICE_CURRENCY=USD
}

do_tag() { printf 'threecast:%s' "$1"; }

# Fetches what threecast created for NAME into DO_DROPLETS, DO_VOLUMES, DO_FIREWALLS, DO_KEYS
# (JSON arrays). Returns 1 when a listing fails, leaving the reason in API_STATUS and API_BODY.
do_inventory() {
  local name=$1
  do_api GET "/v2/droplets?tag_name=$(do_tag "$name")&per_page=200" || return 1
  DO_DROPLETS=$(jq -c '.droplets' <<<"$API_BODY")
  do_api GET "/v2/volumes?per_page=200" || return 1
  DO_VOLUMES=$(jq -c --arg t "$(do_tag "$name")" '[.volumes[] | select(any((.tags // [])[]; . == $t))]' <<<"$API_BODY")
  do_api GET "/v2/firewalls?per_page=200" || return 1
  DO_FIREWALLS=$(jq -c --arg n "threecast-$name" '[.firewalls[] | select(.name == $n)]' <<<"$API_BODY")
  do_api GET "/v2/account/keys?per_page=200" || return 1
  DO_KEYS=$(jq -c --arg n "threecast-$name" '[.ssh_keys[] | select(.name == $n)]' <<<"$API_BODY")
  DO_INVENTORY_COUNT=$(jq -n --argjson d "$DO_DROPLETS" --argjson v "$DO_VOLUMES" --argjson f "$DO_FIREWALLS" \
    --argjson k "$DO_KEYS" '[$d, $v, $f, $k] | map(length) | add')
}

do_print_inventory() {
  jq -r '.[] | "    Droplet     \(.name)   \(.size_slug) in \(.region.slug), \([.networks.v4[] | select(.type == "public") | .ip_address][0] // "no IPv4")"' <<<"$DO_DROPLETS"
  jq -r '.[] | "    volume      \(.name)   \(.size_gigabytes) GiB, holds the node database"' <<<"$DO_VOLUMES"
  jq -r '.[] | "    firewall    \(.name)"' <<<"$DO_FIREWALLS"
  jq -r '.[] | "    SSH key     \(.name) (uploaded by threecast)"' <<<"$DO_KEYS"
}

do_check_leftovers() {
  local name=$1 found
  do_inventory "$name" || do_fail "list what is in your account"
  found=$(jq -n --argjson d "$DO_DROPLETS" --argjson v "$DO_VOLUMES" --argjson f "$DO_FIREWALLS" '$d + $v + $f | length')
  [ "$found" = 0 ] || die "Your DigitalOcean account already has resources for '$name', left from an earlier run." \
    "Delete them:     ./threecast down --provider digitalocean --name $name" \
    "Or use new names: ./threecast up --name another-name"
}

do_ensure_ssh_key() {
  local name=$1 body
  if do_api GET "/v2/account/keys/$UP_KEY_FP"; then
    DO_SSH_KEY_ID=$(jq -r '.ssh_key.id' <<<"$API_BODY")
    DO_SSH_KEY_OWNED=0
    ok "Using the SSH key already in your account ($(jq -r '.ssh_key.name' <<<"$API_BODY"))."
    return
  fi
  [ "$API_STATUS" = 404 ] || do_fail "look up your SSH keys"
  step "Uploading threecast's SSH public key (POST /v2/account/keys)…"
  body=$(jq -nc --arg n "threecast-$name" --arg k "$(cat "$UP_KEY.pub")" '{name: $n, public_key: $k}')
  do_must "upload the SSH key" POST /v2/account/keys "$body"
  DO_SSH_KEY_ID=$(jq -r '.ssh_key.id' <<<"$API_BODY")
  DO_SSH_KEY_OWNED=1
}

# do_create_volume NAME REGION GIB — leaves DO_NEW_VOLUME empty when the region cannot take it.
do_create_volume() {
  local name=$1 region=$2 size=$3 body
  step "Creating a $size GiB volume for the database in $region (POST /v2/volumes)…"
  body=$(jq -nc --arg n "$name-data" --arg r "$region" --argjson s "$size" --arg t "$(do_tag "$name")" \
    '{name: $n, size_gigabytes: $s, region: $r, filesystem_type: "ext4",
      description: "threecast: Snapchain database", tags: [$t]}')
  if ! do_api POST /v2/volumes "$body"; then
    do_limit_hit && do_die_tier "$size GiB volume"
    if do_unavailable; then warn "No volume space in $region right now ($(do_message))."; return 0; fi
    do_fail "create the volume"
  fi
  DO_NEW_VOLUME=$(jq -r '.volume.id' <<<"$API_BODY")
  DO_VOLUME_REGION=$region
  # DigitalOcean names the device after the volume.
  DO_VOLUME_DEVICE="/dev/disk/by-id/scsi-0DO_Volume_$name-data"
  ok "Volume $name-data is ready."
}

# do_create_droplet NAME REGION SIZE — leaves DO_NEW_DROPLET empty when the region has no capacity.
do_create_droplet() {
  local name=$1 region=$2 size=$3 user_data body
  user_data=$(cloud_init_for "$DO_VOLUME_DEVICE")
  body=$(jq -nc --arg n "$name" --arg r "$region" --arg s "$size" --arg image "$DO_IMAGE" --arg ud "$user_data" \
    --argjson key "$DO_SSH_KEY_ID" --arg vol "$DO_NEW_VOLUME" --arg t "$(do_tag "$name")" '
    {name: $n, region: $r, size: $s, image: $image, ssh_keys: [$key], volumes: [$vol],
     user_data: $ud, tags: [$t], ipv6: true, monitoring: false}')
  step "Creating Droplet $name: $size in $region, $DO_IMAGE (POST /v2/droplets)…"
  if ! do_api POST /v2/droplets "$body"; then
    do_limit_hit && do_die_tier "$size Droplet"
    if do_unavailable; then warn "$size is not available in $region right now ($(do_message))."; return 0; fi
    do_fail "create the Droplet"
  fi
  DO_NEW_DROPLET=$(jq -r '.droplet.id' <<<"$API_BODY")
  DO_CREATE_ACTION=$(jq -r '.links.actions[0].id // empty' <<<"$API_BODY")
}

# Cloud firewalls deny everything not allowed, outbound too, so the outbound rules matter:
# the node downloads the snapshot and talks to peers. Docker publishes Grafana, statsd, gRPC and
# the HTTP API on every interface past ufw; this firewall, outside the VM, keeps them closed.
do_create_firewall() {
  local name=$1 droplet=$2 public_api=$3 body
  step "Creating the firewall: SSH (22/tcp) and gossip (3382/udp) open, everything else closed (POST /v2/firewalls)…"
  body=$(jq -nc --arg n "threecast-$name" --argjson d "$droplet" --argjson public "$public_api" '
    def world: {addresses: ["0.0.0.0/0", "::/0"]};
    {name: $n, droplet_ids: [$d],
     inbound_rules: ([{protocol: "tcp", ports: "22", sources: world}, {protocol: "udp", ports: "3382", sources: world}]
                     + (if $public == 1 then [{protocol: "tcp", ports: "3381", sources: world}] else [] end)),
     outbound_rules: [{protocol: "tcp", ports: "1-65535", destinations: world},
                      {protocol: "udp", ports: "1-65535", destinations: world},
                      {protocol: "icmp", ports: "0", destinations: world}]}')
  do_must "create the firewall" POST /v2/firewalls "$body"
  DO_FIREWALL_ID=$(jq -r '.firewall.id' <<<"$API_BODY")
  [ "$public_api" = 0 ] || warn "--public-api: anyone on the internet can read from your node and submit messages through it."
}

# Sets HOST once the Droplet is active.
do_wait_active() {
  local start=$SECONDS
  step "Waiting for the Droplet to start…"
  if [ -n "$DO_CREATE_ACTION" ]; then
    do_wait_action "$DO_CREATE_ACTION" || die "DigitalOcean could not create the Droplet: $DO_ACTION_ERROR"
  fi
  while [ $((SECONDS - start)) -lt 600 ]; do
    if do_api GET "/v2/droplets/$1"; then
      if [ "$(jq -r '.droplet.status' <<<"$API_BODY")" = active ]; then
        HOST=$(jq -r '[.droplet.networks.v4[] | select(.type == "public") | .ip_address][0] // empty' <<<"$API_BODY")
        [ -n "$HOST" ] || die "The Droplet has no public IPv4 address."
        ok "Droplet is running at $HOST."
        return 0
      fi
    elif ! api_transient; then
      do_fail "check on the new Droplet"
    fi
    sleep 3
  done
  die "The Droplet did not start within 10 minutes." "DigitalOcean status: https://status.digitalocean.com"
}

# do_up NAME LOCATION SIZE VOLUME_GB
do_up() {
  local name=$1 location=$2 size=${3:-$DO_SIZE} volume_gb=$4 regions candidates region='' status
  DO_NEW_DROPLET='' DO_NEW_VOLUME='' DO_CREATE_ACTION=''

  cloud_token DIGITALOCEAN_TOKEN DigitalOcean "$DO_TOKEN_HELP"
  step "Checking your DigitalOcean account (GET /v2/account)…"
  do_must "read your account" GET /v2/account
  status=$(jq -r '.account.status' <<<"$API_BODY")
  [ "$status" = active ] || die "Your DigitalOcean account is $status: $(jq -r '.account.status_message' <<<"$API_BODY")" \
    "Sort that out in the DigitalOcean Control Panel, then run this again."
  do_check_leftovers "$name"
  cloud_token_offer_save DIGITALOCEAN_TOKEN

  step "Asking DigitalOcean where $size Droplets and volumes are available (GET /v2/sizes, /v2/regions)…"
  do_must "list Droplet sizes" GET "/v2/sizes?per_page=200"
  DO_SIZES=$API_BODY
  do_must "list regions" GET "/v2/regions?per_page=200"
  DO_REGION_LIST=$API_BODY
  case "$location" in
    '')  regions=$DO_REGIONS ;;
    any) regions="$DO_REGIONS $(jq -r '[.regions[].slug] | join(" ")' <<<"$DO_REGION_LIST")" ;;
    *)   regions=$location ;;
  esac
  candidates=$(do_candidates "$size" "$regions")
  [ -n "$candidates" ] || die "DigitalOcean offers $size with volumes in none of: $regions." \
    "All regions: ./threecast up --provider digitalocean --location any" \
    "Or: ./threecast up --provider hetzner, or your own server: ./threecast up --host root@IP"

  say "  threecast would create, in ${candidates%%$'\n'*}:"
  do_show_cost "$size" "${candidates%%$'\n'*}" "$volume_gb"
  confirm "Create these resources now?" || die "Stopped. Nothing was created."

  up_local_key
  up_begin_creating do_rollback
  do_ensure_ssh_key "$name"
  for region in $candidates; do
    if [ -n "$DO_NEW_VOLUME" ]; then
      step "Moving to $region: deleting the volume in $DO_VOLUME_REGION first (volumes cannot change region)…"
      do_delete_volume "$DO_NEW_VOLUME" "$name-data" || die "Could not delete the volume in $DO_VOLUME_REGION."
      DO_NEW_VOLUME=''
    fi
    do_create_volume "$name" "$region" "$volume_gb"
    [ -n "$DO_NEW_VOLUME" ] || continue
    do_create_droplet "$name" "$region" "$size"
    [ -z "$DO_NEW_DROPLET" ] || break
  done
  [ -n "$DO_NEW_DROPLET" ] || die "No region threecast tried could take the Droplet right now." \
    "Try again later, or: ./threecast up --provider digitalocean --location any"
  do_create_firewall "$name" "$DO_NEW_DROPLET" "$UP_PUBLIC_API"
  do_wait_active "$DO_NEW_DROPLET"

  up_rented_login
  up_wait_ready

  up_save_target digitalocean
  target_set DO_DROPLET_ID "$DO_NEW_DROPLET"
  target_set DO_VOLUME_ID "$DO_NEW_VOLUME"
  target_set DO_FIREWALL_ID "$DO_FIREWALL_ID"
  target_set DO_SSH_KEY_ID "$DO_SSH_KEY_ID"
  target_set DO_SSH_KEY_OWNED "$DO_SSH_KEY_OWNED"
  target_set PRICE_HOURLY "$UP_PRICE_HOURLY"
  target_set PRICE_CURRENCY "$UP_PRICE_CURRENCY"
  up_disarm_rollback

  ok "Your Droplet is ready: root@$HOST ($size in $region). Saved as '$name'."
  hint "It costs about $UP_PRICE_HOURLY USD per hour until you run ./threecast down."
  up_print_next
}

# Runs from the EXIT trap with errexit off. do_check_leftovers proved nothing was tagged or named
# for NAME before this run, so what is there now is this run's, including a resource created just
# as Ctrl-C arrived, before its reply (and its id) reached threecast.
do_rollback() {
  local name=$UP_NAME left=0
  do_delete_owned "$name" || left=1
  if [ "$left" = 0 ]; then
    ok "Nothing from this run is left in your DigitalOcean account."
  else
    warn "Some resources could not be deleted. Remove them in the DigitalOcean Control Panel,"
    warn "or run: ./threecast down --provider digitalocean --name $name"
  fi
}

# The do_delete_* helpers serve both the rollback and `down`: each reports, treats 404 as done,
# and returns 1 instead of stopping, so cleanup keeps going.

do_delete_droplet() { # ID LABEL
  local start=$SECONDS
  if ! do_api DELETE "/v2/droplets/$1"; then
    [ "$API_STATUS" = 404 ] && return 0
    warn "Could not delete Droplet $2: $(do_error)"
    return 1
  fi
  # Deletion is asynchronous; its volume stays attached until the Droplet is really gone.
  while [ $((SECONDS - start)) -lt 300 ]; do
    if ! do_api GET "/v2/droplets/$1" && [ "$API_STATUS" = 404 ]; then
      ok "Deleted Droplet $2."
      return 0
    fi
    sleep 3
  done
  warn "Droplet $2 was still there 5 minutes after deleting it."
  return 1
}

do_delete_volume() { # ID LABEL
  local tries=0 droplet region
  if do_api GET "/v2/volumes/$1"; then
    droplet=$(jq -r '.volume.droplet_ids[0] // empty' <<<"$API_BODY")
    region=$(jq -r '.volume.region.slug // empty' <<<"$API_BODY")
    if [ -n "$droplet" ] && do_api POST "/v2/volumes/$1/actions" \
        "$(jq -nc --argjson d "$droplet" --arg r "$region" '{type: "detach", droplet_id: $d, region: $r}')"; then
      do_wait_action "$(jq -r '.action.id' <<<"$API_BODY")" || true
    fi
  elif [ "$API_STATUS" = 404 ]; then
    return 0
  fi
  while [ "$tries" -lt 20 ]; do
    if do_api DELETE "/v2/volumes/$1"; then ok "Deleted volume $2 and the data on it."; return 0; fi
    [ "$API_STATUS" = 404 ] && return 0
    case "$API_STATUS" in 409|422) ;; *) api_transient || break ;; esac
    tries=$((tries + 1))
    sleep 3
  done
  warn "Could not delete volume $2: $(do_error)"
  return 1
}

do_delete_firewall() { # ID LABEL
  if ! do_api DELETE "/v2/firewalls/$1"; then
    [ "$API_STATUS" = 404 ] && return 0
    warn "Could not delete firewall $2: $(do_error)"
    return 1
  fi
  ok "Deleted firewall $2."
}

do_delete_ssh_key() { # ID LABEL
  if ! do_api DELETE "/v2/account/keys/$1"; then
    [ "$API_STATUS" = 404 ] && return 0
    warn "Could not delete SSH key $2: $(do_error)"
    return 1
  fi
  ok "Deleted SSH key $2 from your DigitalOcean account."
}

# do_delete_owned NAME — Droplets first, so their volumes come free, then volumes, the firewall
# and the SSH key. Returns 1 if anything could not be deleted.
do_delete_owned() {
  local name=$1 failed=0 id label tries=1
  # A dropped connection here would leave a volume billing, so give it a few tries.
  until do_inventory "$name"; do
    if ! api_transient || [ "$tries" -ge 3 ]; then
      warn "Could not list what threecast created: $(do_error)"
      return 1
    fi
    tries=$((tries + 1))
    sleep 5
  done
  for id in $(jq -r '.[].id' <<<"$DO_DROPLETS"); do
    label=$(jq -r --argjson id "$id" '.[] | select(.id == $id) | .name' <<<"$DO_DROPLETS")
    step "Deleting Droplet $label (DELETE /v2/droplets, waits until it is gone)…"
    do_delete_droplet "$id" "$label" || failed=1
  done
  for id in $(jq -r '.[].id' <<<"$DO_VOLUMES"); do
    do_delete_volume "$id" "$(jq -r --arg id "$id" '.[] | select(.id == $id) | .name' <<<"$DO_VOLUMES")" || failed=1
  done
  for id in $(jq -r '.[].id' <<<"$DO_FIREWALLS"); do
    do_delete_firewall "$id" "threecast-$name" || failed=1
  done
  for id in $(jq -r '.[].id' <<<"$DO_KEYS"); do
    do_delete_ssh_key "$id" "threecast-$name" || failed=1
  done
  return "$failed"
}

# do_down NAME — shows what threecast created for NAME, deletes it once confirmed, and stops
# (keeping the target) if anything is left afterwards.
do_down() {
  local name=$1
  cloud_token DIGITALOCEAN_TOKEN DigitalOcean "$DO_TOKEN_HELP"
  step "Looking up everything threecast created for '$name' in your DigitalOcean account…"
  do_inventory "$name" || do_fail "list what is in your account"
  cloud_token_offer_save DIGITALOCEAN_TOKEN
  if [ "$DO_INVENTORY_COUNT" = 0 ]; then
    ok "Nothing for '$name' exists in this DigitalOcean account any more."
    down_saved_but_missing "this DigitalOcean team" "another DigitalOcean team"
    return 0
  fi
  do_print_inventory
  say "These are deleted for good, the node's data included, and their billing stops."
  down_confirm_name "$name"
  do_delete_owned "$name" || true

  step "Checking that nothing for '$name' is left…"
  do_inventory "$name" || do_fail "list what is in your account"
  if [ "$DO_INVENTORY_COUNT" = 0 ]; then
    ok "Nothing is left. Billing for '$name' has stopped."
    return 0
  fi
  warn "Still in your DigitalOcean account:"
  do_print_inventory >&2
  down_keep_target "$name" "Delete them in the DigitalOcean Control Panel, or run ./threecast down --name $name again."
}
