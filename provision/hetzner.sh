# shellcheck shell=bash
# threecast — MIT License
# Hetzner Cloud for `up` and `down` (API reference: https://docs.hetzner.cloud).
# Everything threecast creates carries the label threecast=<name>, and `down` deletes by that label.

HCLOUD_API=${HCLOUD_API:-https://api.hetzner.cloud/v1}
HZ_TYPES="cpx42 ccx23 cax31 cx43"
HZ_EU_LOCATIONS="fsn1 nbg1 hel1"
HZ_OTHER_LOCATIONS="ash hil sin"
HZ_IMAGE=ubuntu-24.04
# Hetzner bills volumes hourly but publishes only a monthly price. Server prices reach their
# monthly cap after about 624 hours, so dividing by 624 gives an upper estimate per hour.
HZ_HOURS_PER_MONTH=624
HZ_TOKEN_HELP="Hetzner Console → your project → Security → API tokens → Generate API token (Read & Write)"

hz_api() { api_call "$1" "$HCLOUD_API$2" "$HCLOUD_TOKEN" "${3:-}"; }

hz_code() { jq -r '.error.code // empty' <<<"$API_BODY" 2>/dev/null || true; }

# The last failed call in one line, e.g. "403 resource_limit_exceeded: volume size limit exceeded".
hz_error() {
  if [ "$API_STATUS" = 000 ]; then
    printf 'no answer from %s (%s)' "$HCLOUD_API" "$API_NETERR"
  else
    printf '%s %s' "$API_STATUS" "$(jq -r '.error | "\(.code): \(.message)"' <<<"$API_BODY" 2>/dev/null || printf 'unexpected reply')"
  fi
}

# hz_fail "what threecast was doing" — explains the last failed call and stops.
hz_fail() {
  case "$API_STATUS:$(hz_code)" in
    401:*) die "Hetzner rejected the API token (401 unauthorized). It came from $CLOUD_TOKEN_SOURCE." \
             "Create a new one: $HZ_TOKEN_HELP" ;;
    403:forbidden) die "Hetzner did not allow threecast to $1 ($(hz_error))." \
             "A Read-only token cannot create anything. Create a Read & Write one: $HZ_TOKEN_HELP" ;;
  esac
  die "Hetzner could not $1: $(hz_error)" "Try again in a few minutes. Hetzner status: https://status.hetzner.com"
}

# hz_must "what" METHOD PATH [JSON] — the reply is in API_BODY.
hz_must() {
  local what=$1
  shift
  hz_api "$@" || hz_fail "$what"
}

# hz_wait_action ID — until Hetzner finishes an action. Sets HZ_ACTION_ERROR when it fails.
hz_wait_action() {
  local start=$SECONDS
  HZ_ACTION_ERROR=
  while [ $((SECONDS - start)) -lt 600 ]; do
    if hz_api GET "/actions/$1"; then
      case "$(jq -r '.action.status' <<<"$API_BODY")" in
        success) return 0 ;;
        error) HZ_ACTION_ERROR=$(jq -r '.action.error | "\(.code): \(.message)"' <<<"$API_BODY"); return 1 ;;
      esac
    elif ! api_transient; then
      HZ_ACTION_ERROR=$(hz_error)
      return 1
    fi
    sleep 2
  done
  HZ_ACTION_ERROR="still running after 10 minutes"
  return 1
}

# hz_list KIND NAME — sets API_BODY to every KIND (servers, volumes, ...) labelled threecast=NAME.
hz_list() {
  hz_must "list your $1" GET "/$1?label_selector=threecast%3D$2&per_page=50"
}

# hz_candidates TYPES LOCATIONS — "type@location" for every pair on sale now, best first.
# Reads HZ_SERVER_TYPES. Each location of a type says whether it is `available` (not sold out)
# and carries a `deprecation` once Hetzner starts retiring the type there.
hz_candidates() {
  local type location on_sale
  for type in $1; do
    on_sale=" $(jq -r --arg t "$type" '[.server_types[] | select(.name == $t) | .locations[]
      | select(.available == true and .deprecation == null) | .name] | join(" ")' <<<"$HZ_SERVER_TYPES") "
    for location in $2; do
      case "$on_sale" in *" $location "*) printf '%s@%s\n' "$type" "$location" ;; esac
    done
  done
}

# hz_price TYPE LOCATION — "server_h server_m ipv4_h ipv4_m volume_per_gb_month currency" from HZ_PRICING.
hz_price() {
  jq -r --arg t "$1" --arg l "$2" '.pricing as $p
    | [($p.server_types[] | select(.name == $t) | .prices[] | select(.location == $l)
        | .price_hourly.net, .price_monthly.net),
       ($p.primary_ips[] | select(.type == "ipv4") | .prices[] | select(.location == $l)
        | .price_hourly.net, .price_monthly.net),
       $p.volume.price_per_gb_month.net, $p.currency]
    | if length == 6 then join(" ") else empty end' <<<"$HZ_PRICING"
}

# hz_total_hourly TYPE LOCATION VOLUME_GB — prints nothing when the price list lacks that pair.
hz_total_hourly() {
  local p
  p=$(hz_price "$1" "$2")
  [ -n "$p" ] || return 0
  # shellcheck disable=SC2086 # hz_price prints six space-separated words
  set -- $p "$3"
  cost_hourly "$1" "$3" "$7" "$5" "$HZ_HOURS_PER_MONTH"
}

hz_show_cost() { # TYPE LOCATION VOLUME_GB
  local p spec
  p=$(hz_price "$1" "$2")
  [ -n "$p" ] || die "Hetzner's price list has no price for $1 in $2." "Pick another type or location (./threecast up --help)."
  spec=$(jq -r --arg t "$1" '.server_types[] | select(.name == $t) | "\(.cores) vCPU, \(.memory) GB RAM"' <<<"$HZ_SERVER_TYPES")
  # shellcheck disable=SC2086 # hz_price prints six space-separated words
  set -- "$1" "$2" "$3" $p
  show_cost "$9" "Server $1 in $2 ($spec)" "$4" "$5" "$6" "$7" "Volume, $3 GB for the database" "$3" "$8" "$HZ_HOURS_PER_MONTH"
  UP_PRICE_HOURLY=$(cost_hourly "$4" "$6" "$3" "$8" "$HZ_HOURS_PER_MONTH")
  UP_PRICE_CURRENCY=$9
}

# SSH keys are not checked: one left from an earlier run is simply reused.
hz_check_leftovers() {
  local name=$1 kind found=''
  for kind in servers volumes firewalls primary_ips; do
    hz_list "$kind" "$name"
    [ "$(jq -r ".$kind | length" <<<"$API_BODY")" = 0 ] || found="$found${found:+,} $(hz_kind_words "$kind")"
  done
  [ -z "$found" ] || die "Your Hetzner project already has$found labelled threecast=$name, left from an earlier run." \
    "Delete them:      ./threecast down --provider hetzner --name $name" \
    "Or use new names: ./threecast up --name another-name"
}

hz_ensure_ssh_key() {
  local name=$1 key_name="threecast-$1"
  hz_must "look up your SSH keys" GET "/ssh_keys?fingerprint=$UP_KEY_FP"
  HZ_SSH_KEY_ID=$(jq -r '.ssh_keys[0].id // empty' <<<"$API_BODY")
  if [ -n "$HZ_SSH_KEY_ID" ]; then
    HZ_SSH_KEY_OWNED=0
    ok "Using the SSH key already in your project ($(jq -r '.ssh_keys[0].name' <<<"$API_BODY"))."
    return
  fi
  step "Uploading threecast's SSH public key (POST /ssh_keys)…"
  if ! hz_api POST /ssh_keys "$(hz_ssh_key_body "$key_name" "$name")"; then
    # A different key already has that name (e.g. from a deleted ~/.threecast): use a fresh name.
    [ "$API_STATUS:$(hz_code)" = 409:uniqueness_error ] || hz_fail "upload the SSH key"
    key_name="threecast-$name-$(date +%s)"
    hz_must "upload the SSH key" POST /ssh_keys "$(hz_ssh_key_body "$key_name" "$name")"
  fi
  HZ_SSH_KEY_ID=$(jq -r '.ssh_key.id' <<<"$API_BODY")
  HZ_SSH_KEY_OWNED=1
}

hz_ssh_key_body() { # KEY_NAME TARGET_NAME
  jq -nc --arg n "$1" --arg k "$(cat "$UP_KEY.pub")" --arg label "$2" '{name: $n, public_key: $k, labels: {threecast: $label}}'
}

# Docker publishes Grafana (3000), statsd (8125/8126), gRPC (3383) and the HTTP API (3381) on
# every interface, past ufw. This firewall sits outside the VM, so it is what keeps them closed.
hz_create_firewall() {
  local name=$1 public_api=$2 body
  step "Creating the firewall: SSH (22/tcp) and gossip (3382/udp) open, everything else closed (POST /firewalls)…"
  body=$(jq -nc --arg n "threecast-$name" --arg label "$name" --argjson public "$public_api" '
    def open(proto; port; why): {direction: "in", protocol: proto, port: port, description: why,
                                 source_ips: ["0.0.0.0/0", "::/0"]};
    {name: $n, labels: {threecast: $label},
     rules: ([open("tcp"; "22"; "ssh"), open("udp"; "3382"; "snapchain gossip (QUIC)")]
             + (if $public == 1 then [open("tcp"; "3381"; "snapchain HTTP API")] else [] end))}')
  hz_must "create the firewall" POST /firewalls "$body"
  HZ_FIREWALL_ID=$(jq -r '.firewall.id' <<<"$API_BODY")
  [ "$public_api" = 0 ] || warn "--public-api: anyone on the internet can read from your node and submit messages through it."
}

# hz_create_volume NAME LOCATION GB — leaves HZ_NEW_VOLUME empty when the location has no space.
hz_create_volume() {
  local name=$1 location=$2 size=$3 body
  step "Creating a $size GB volume for the database in $location (POST /volumes)…"
  body=$(jq -nc --arg n "$name-data" --arg l "$location" --argjson s "$size" --arg label "$name" \
    '{name: $n, size: $s, location: $l, format: "ext4", automount: false, labels: {threecast: $label}}')
  if ! hz_api POST /volumes "$body"; then
    case "$API_STATUS:$(hz_code)" in
      403:resource_limit_exceeded) die "Hetzner refused a $size GB volume: this account's volume limit is lower ($(hz_error))." \
        "New Hetzner accounts may have at most 1024 GB of volumes in total, and volumes you already have count too." \
        "See your limits: Hetzner Console → Limits. Hetzner raises them only after your first paid invoice." \
        "Instead: ./threecast up --provider digitalocean, or your own server: ./threecast up --host root@IP" ;;
      422:no_space_left_in_location|412:resource_unavailable)
        warn "Hetzner cannot give out volumes in $location right now ($(hz_code))."; return 0 ;;
      409:uniqueness_error) die "A volume named $name-data already exists in this Hetzner project." \
        "Delete it in the Hetzner Console, or use another name: ./threecast up --name another-name" ;;
    esac
    hz_fail "create the volume"
  fi
  HZ_NEW_VOLUME=$(jq -r '.volume.id' <<<"$API_BODY")
  HZ_VOLUME_DEVICE=$(jq -r '.volume.linux_device' <<<"$API_BODY")
  HZ_VOLUME_LOCATION=$location
  hz_wait_action "$(jq -r '.action.id' <<<"$API_BODY")" || die "Hetzner could not create the volume: $HZ_ACTION_ERROR"
  ok "Volume $name-data is ready ($HZ_VOLUME_DEVICE)."
}

# hz_create_server NAME TYPE LOCATION — leaves HZ_NEW_SERVER empty when the type is sold out there.
hz_create_server() {
  local name=$1 type=$2 location=$3 user_data body action
  user_data=$(cloud_init_for "$HZ_VOLUME_DEVICE")
  body=$(jq -nc --arg n "$name" --arg t "$type" --arg l "$location" --arg image "$HZ_IMAGE" --arg ud "$user_data" \
    --argjson key "$HZ_SSH_KEY_ID" --argjson fw "$HZ_FIREWALL_ID" --argjson vol "$HZ_NEW_VOLUME" '
    {name: $n, server_type: $t, location: $l, image: $image, start_after_create: true,
     ssh_keys: [$key], firewalls: [{firewall: $fw}], volumes: [$vol], automount: false,
     public_net: {enable_ipv4: true, enable_ipv6: true}, user_data: $ud, labels: {threecast: $n}}')
  step "Creating server $name: $type in $location, $HZ_IMAGE (POST /servers)…"
  if ! hz_api POST /servers "$body"; then
    case "$API_STATUS:$(hz_code)" in
      412:resource_unavailable|422:placement_error) warn "$type is sold out in $location right now ($(hz_code))."; return 0 ;;
      403:resource_limit_exceeded) die "This Hetzner account's limits do not allow a $type server ($(hz_error))." \
        "New accounts start with low limits on servers and CPU cores. See and raise them: Hetzner Console → Limits." \
        "Or: ./threecast up --provider digitalocean, or your own server: ./threecast up --host root@IP" ;;
      403:*) die "Hetzner did not let this account create a server ($(hz_error))." \
        "Since 2026-06-26 Hetzner restricts new cloud servers for new customers and some existing ones" \
        "(status.hetzner.com: \"Limited availability of cloud instances\"). Credit or vouchers do not lift it." \
        "New accounts also start with low limits: Hetzner Console → Limits." \
        "Try again tomorrow, or: ./threecast up --provider digitalocean, or your own server: --host root@IP" ;;
      409:uniqueness_error) die "A server named $name already exists in this Hetzner project." \
        "Use another name: ./threecast up --name another-name" ;;
    esac
    hz_fail "create the server"
  fi
  HZ_NEW_SERVER=$(jq -r '.server.id' <<<"$API_BODY")
  # Hetzner creates the server's IP addresses itself, unlabelled until hz_label_ips.
  HZ_NEW_IPS=$(jq -r '[.server.public_net.ipv4.id, .server.public_net.ipv6.id] | map(select(. != null)) | join(" ")' <<<"$API_BODY")
  for action in $(jq -r '[.action.id] + [.next_actions[]?.id] | join(" ")' <<<"$API_BODY"); do
    hz_wait_action "$action" || die "Hetzner could not start the server: $HZ_ACTION_ERROR"
  done
}

# Sets HOST once the server reports "running".
hz_wait_running() {
  local start=$SECONDS
  step "Waiting for the server to start…"
  while [ $((SECONDS - start)) -lt 600 ]; do
    if hz_api GET "/servers/$1"; then
      if [ "$(jq -r '.server.status' <<<"$API_BODY")" = running ]; then
        HOST=$(jq -r '.server.public_net.ipv4.ip' <<<"$API_BODY")
        ok "Server is running at $HOST."
        return 0
      fi
    elif ! api_transient; then
      hz_fail "check on the new server"
    fi
    sleep 3
  done
  die "The server did not start within 10 minutes." "Hetzner status: https://status.hetzner.com"
}

hz_label_ips() {
  local name=$1 ip body
  body=$(jq -nc --arg n "$name" '{labels: {threecast: $n}, auto_delete: true}')
  for ip in $HZ_NEW_IPS; do
    hz_must "label the server's IP address" PUT "/primary_ips/$ip" "$body"
  done
}

# hz_up NAME LOCATION SERVER_TYPE VOLUME_GB
hz_up() {
  local name=$1 location=$2 types=${3:-$HZ_TYPES} volume_gb=$4
  local locations candidates candidate first first_hourly hourly type='' loc=''
  case "$location" in
    '')  locations=$HZ_EU_LOCATIONS ;;
    any) locations="$HZ_EU_LOCATIONS $HZ_OTHER_LOCATIONS" ;;
    *)   locations=$location ;;
  esac
  HZ_NEW_SERVER='' HZ_NEW_VOLUME='' HZ_NEW_IPS=''

  cloud_token HCLOUD_TOKEN Hetzner "$HZ_TOKEN_HELP"
  step "Checking your Hetzner project for leftovers labelled threecast=${name}…"
  hz_check_leftovers "$name"
  cloud_token_offer_save HCLOUD_TOKEN

  step "Asking Hetzner which server types are for sale right now (GET /server_types)…"
  hz_must "list server types" GET "/server_types?per_page=50"
  HZ_SERVER_TYPES=$API_BODY
  candidates=$(hz_candidates "$types" "$locations")
  [ -n "$candidates" ] || die "Hetzner sells none of these server types in $locations right now: $types." \
    "Stock changes during the day, so trying again later often works." \
    "More locations (US, Singapore; dearer, less included traffic): ./threecast up --provider hetzner --location any" \
    "Or: ./threecast up --provider digitalocean, or your own server: ./threecast up --host root@IP"
  first=${candidates%%$'\n'*}

  step "Reading prices (GET /pricing)…"
  hz_must "read the price list" GET /pricing
  HZ_PRICING=$API_BODY
  say "  threecast would create, with ${first%@*} in ${first#*@}:"
  hz_show_cost "${first%@*}" "${first#*@}" "$volume_gb"
  first_hourly=$UP_PRICE_HOURLY
  confirm "Create these resources now?" || die "Stopped. Nothing was created."

  up_local_key
  up_begin_creating hz_rollback
  hz_ensure_ssh_key "$name"
  hz_create_firewall "$name" "$UP_PUBLIC_API"

  for candidate in $candidates; do
    type=${candidate%@*}
    loc=${candidate#*@}
    hourly=$(hz_total_hourly "$type" "$loc" "$volume_gb")
    [ -n "$hourly" ] || continue
    if [ "$candidate" != "$first" ] && LC_ALL=C awk -v a="$hourly" -v b="$first_hourly" 'BEGIN { exit !(a > b) }'; then
      warn "Next option: $type in $loc, about $hourly $UP_PRICE_CURRENCY/hour in total instead of $first_hourly."
      confirm "Use $type in $loc?" || die "Stopped at your request."
    fi
    if [ -n "$HZ_NEW_VOLUME" ] && [ "$HZ_VOLUME_LOCATION" != "$loc" ]; then
      step "Moving to $loc: deleting the volume in $HZ_VOLUME_LOCATION first (volumes cannot change location)…"
      hz_delete_volume "$HZ_NEW_VOLUME" "$name-data" || die "Could not delete the volume in $HZ_VOLUME_LOCATION."
      HZ_NEW_VOLUME=''
    fi
    [ -n "$HZ_NEW_VOLUME" ] || hz_create_volume "$name" "$loc" "$volume_gb"
    [ -n "$HZ_NEW_VOLUME" ] || continue
    hz_create_server "$name" "$type" "$loc"
    [ -z "$HZ_NEW_SERVER" ] || break
  done
  [ -n "$HZ_NEW_SERVER" ] || die "Every server type and location threecast tried was sold out." \
    "Try again later, or: ./threecast up --provider hetzner --location any, or --provider digitalocean"
  UP_PRICE_HOURLY=$hourly

  hz_wait_running "$HZ_NEW_SERVER"
  hz_label_ips "$name"
  up_rented_login
  up_wait_ready

  up_save_target hetzner
  target_set HZ_SERVER_ID "$HZ_NEW_SERVER"
  target_set HZ_VOLUME_ID "$HZ_NEW_VOLUME"
  target_set HZ_FIREWALL_ID "$HZ_FIREWALL_ID"
  target_set HZ_SSH_KEY_ID "$HZ_SSH_KEY_ID"
  target_set HZ_SSH_KEY_OWNED "$HZ_SSH_KEY_OWNED"
  target_set PRICE_HOURLY "$UP_PRICE_HOURLY"
  target_set PRICE_CURRENCY "$UP_PRICE_CURRENCY"
  up_disarm_rollback

  ok "Your server is ready: root@$HOST ($type in $loc). Saved as '$name'."
  hint "It costs about $UP_PRICE_HOURLY $UP_PRICE_CURRENCY per hour until you run ./threecast down."
  up_print_next
}

# Runs from the EXIT trap with errexit off. hz_check_leftovers proved that nothing carried the
# label before this run, so whatever carries it now is this run's, including a resource Hetzner
# created just as Ctrl-C arrived, before its reply (and its id) reached threecast.
hz_rollback() {
  local name=$UP_NAME left=0
  hz_delete_labelled "$name" || left=1
  if [ "$left" = 0 ]; then
    ok "Nothing from this run is left in your Hetzner project."
  else
    warn "Some resources could not be deleted. Remove them in the Hetzner Console (label threecast=$name),"
    warn "or run: ./threecast down --provider hetzner --name $name"
  fi
}

# The hz_delete_* helpers serve both the rollback and `down`. Each one reports, treats
# "already gone" (404) as done, and returns 1 instead of stopping, so cleanup keeps going.

hz_delete_server() { # ID LABEL
  if ! hz_api DELETE "/servers/$1"; then
    [ "$API_STATUS" = 404 ] && return 0
    warn "Could not delete server $2: $(hz_error)"
    return 1
  fi
  hz_wait_action "$(jq -r '.action.id' <<<"$API_BODY")" || { warn "Deleting server $2 failed: $HZ_ACTION_ERROR"; return 1; }
  ok "Deleted server $2."
}

hz_delete_volume() { # ID LABEL
  local tries=0
  if hz_api GET "/volumes/$1"; then
    if [ -n "$(jq -r '.volume.server // empty' <<<"$API_BODY")" ] && hz_api POST "/volumes/$1/actions/detach"; then
      hz_wait_action "$(jq -r '.action.id' <<<"$API_BODY")" || true
    fi
  elif [ "$API_STATUS" = 404 ]; then
    return 0
  fi
  # Right after its server is deleted a volume can still be busy detaching; retry briefly.
  while [ "$tries" -lt 20 ]; do
    if hz_api DELETE "/volumes/$1"; then ok "Deleted volume $2 and the data on it."; return 0; fi
    [ "$API_STATUS" = 404 ] && return 0
    case "$API_STATUS" in 409|422|423) ;; *) api_transient || break ;; esac
    tries=$((tries + 1))
    sleep 3
  done
  warn "Could not delete volume $2: $(hz_error)"
  return 1
}

hz_delete_firewall() { # ID LABEL
  local tries=0
  # A firewall stays "in use" for a few seconds after its server is gone (422 resource_in_use).
  while [ "$tries" -lt 20 ]; do
    if hz_api DELETE "/firewalls/$1"; then ok "Deleted firewall $2."; return 0; fi
    [ "$API_STATUS" = 404 ] && return 0
    [ "$API_STATUS:$(hz_code)" = 422:resource_in_use ] || api_transient || break
    tries=$((tries + 1))
    sleep 3
  done
  warn "Could not delete firewall $2: $(hz_error)"
  return 1
}

hz_delete_primary_ip() { # ID
  local ip
  if ! hz_api GET "/primary_ips/$1"; then
    [ "$API_STATUS" = 404 ] && return 0
    warn "Could not check IP address $1: $(hz_error)"
    return 1
  fi
  ip=$(jq -r '.primary_ip.ip' <<<"$API_BODY")
  if [ -n "$(jq -r '.primary_ip.assignee_id // empty' <<<"$API_BODY")" ]; then
    warn "IP address $ip is still assigned to a server, so it was not deleted."
    return 1
  fi
  if ! hz_api DELETE "/primary_ips/$1"; then
    [ "$API_STATUS" = 404 ] && return 0
    warn "Could not delete IP address $ip: $(hz_error)"
    return 1
  fi
  ok "Deleted IP address $ip."
}

hz_delete_ssh_key() { # ID LABEL
  if ! hz_api DELETE "/ssh_keys/$1"; then
    [ "$API_STATUS" = 404 ] && return 0
    warn "Could not delete SSH key $2: $(hz_error)"
    return 1
  fi
  ok "Deleted SSH key $2 from your Hetzner project."
}

# hz_delete_labelled NAME — deletes everything labelled threecast=NAME. Servers go first: volumes
# and firewalls cannot be deleted while a server holds them. Lists through hz_api, not hz_must,
# so in the rollback one failure stops nothing else.
hz_delete_labelled() {
  local name=$1 failed=0 kind list id label server_ips tries
  for kind in servers volumes firewalls primary_ips ssh_keys; do
    # A dropped connection here would leave a volume billing, so give it a few tries.
    tries=1
    until hz_api GET "/$kind?label_selector=threecast%3D$name&per_page=50"; do
      if ! api_transient || [ "$tries" -ge 3 ]; then
        warn "Could not list your $(hz_kind_words "$kind"): $(hz_error)"
        failed=1
        continue 2
      fi
      tries=$((tries + 1))
      sleep 5
    done
    list=$API_BODY
    for id in $(jq -r --arg kind "$kind" '.[$kind][].id' <<<"$list"); do
      label=$(hz_name "$list" "$kind" "$id")
      case "$kind" in
        servers)     step "Deleting server $label (DELETE /servers, waits for Hetzner)…"
                     hz_delete_server "$id" "$label" ;;
        volumes)     hz_delete_volume "$id" "$label" ;;
        firewalls)   hz_delete_firewall "$id" "$label" ;;
        primary_ips) hz_delete_primary_ip "$id" ;;
        ssh_keys)    hz_delete_ssh_key "$id" "$label" ;;
      esac || failed=1
    done
    # A server's IP addresses carry no label until hz_label_ips, and without auto_delete they
    # outlive the server (a server whose create reply never arrived has neither), so they are
    # taken from the server listing. Those that went with their server answer 404.
    if [ "$kind" = servers ]; then
      server_ips=$(jq -r '[.servers[].public_net | .ipv4.id, .ipv6.id] | map(select(. != null)) | join(" ")' <<<"$list")
      for id in $server_ips; do hz_delete_primary_ip "$id" || failed=1; done
    fi
  done
  return "$failed"
}

hz_kind_words() {
  case "$1" in primary_ips) printf 'IP addresses' ;; ssh_keys) printf 'SSH keys' ;; *) printf '%s' "$1" ;; esac
}

# hz_name JSON KIND ID — the name of one listed resource, for messages.
hz_name() {
  jq -r --arg kind "$2" --argjson id "$3" '.[$kind][] | select(.id == $id) | .name' <<<"$1"
}

# Fetches everything labelled threecast=NAME into HZ_SERVERS, HZ_VOLUMES, ... and counts it.
hz_inventory() {
  local name=$1
  hz_list servers "$name";     HZ_SERVERS=$API_BODY
  hz_list volumes "$name";     HZ_VOLUMES=$API_BODY
  hz_list firewalls "$name";   HZ_FIREWALLS=$API_BODY
  hz_list primary_ips "$name"; HZ_IPS=$API_BODY
  hz_list ssh_keys "$name";    HZ_KEYS=$API_BODY
  HZ_INVENTORY_COUNT=$(jq -n --argjson s "$HZ_SERVERS" --argjson v "$HZ_VOLUMES" --argjson f "$HZ_FIREWALLS" \
    --argjson i "$HZ_IPS" --argjson k "$HZ_KEYS" \
    '[$s.servers, $v.volumes, $f.firewalls, $i.primary_ips, $k.ssh_keys] | map(length) | add')
}

hz_print_inventory() {
  jq -r '.servers[] | "    server      \(.name)   \(.server_type.name) in \(.location.name), \(.public_net.ipv4.ip // "no IPv4")"' <<<"$HZ_SERVERS"
  jq -r '.volumes[] | "    volume      \(.name)   \(.size) GB, holds the node database"' <<<"$HZ_VOLUMES"
  jq -r '.firewalls[] | "    firewall    \(.name)"' <<<"$HZ_FIREWALLS"
  jq -r '.primary_ips[] | "    IP address  \(.ip)\(if .assignee_id then " (goes with its server)" else "" end)"' <<<"$HZ_IPS"
  jq -r '.ssh_keys[] | "    SSH key     \(.name) (uploaded by threecast)"' <<<"$HZ_KEYS"
}

# hz_down NAME — shows what is labelled threecast=NAME, deletes it once confirmed, and stops
# (keeping the target) if anything is left afterwards.
hz_down() {
  local name=$1
  cloud_token HCLOUD_TOKEN Hetzner "$HZ_TOKEN_HELP"
  step "Looking up everything labelled threecast=$name in your Hetzner project…"
  hz_inventory "$name"
  cloud_token_offer_save HCLOUD_TOKEN
  if [ "$HZ_INVENTORY_COUNT" = 0 ]; then
    ok "Nothing labelled threecast=$name exists in this Hetzner project any more."
    down_saved_but_missing "this Hetzner project" "another Hetzner project"
    return 0
  fi
  hz_print_inventory
  say "These are deleted for good, the node's data included, and their billing stops."
  down_confirm_name "$name"
  hz_delete_labelled "$name" || true
  hz_verify_gone "$name"
}

hz_verify_gone() {
  local name=$1 tries=0
  step "Checking that nothing labelled threecast=$name is left…"
  while :; do
    hz_inventory "$name"
    if [ "$HZ_INVENTORY_COUNT" = 0 ]; then
      ok "Nothing is left. Billing for '$name' has stopped."
      return 0
    fi
    tries=$((tries + 1))
    [ "$tries" -lt 10 ] || break
    sleep 3
  done
  warn "Still in your Hetzner project:"
  hz_print_inventory >&2
  down_keep_target "$name" "Delete them in the Hetzner Console, or run ./threecast down --name $name again."
}
