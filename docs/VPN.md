# VPN killswitch

Findr's built-in torrent client can be kept on your VPN. With the killswitch on, torrent connections can only use the VPN's address, they stop the moment the VPN looks wrong, and downloads wait (they don't fail) until it is back.

It is a strong in-app protection, not a guarantee: some traffic is outside Findr's control (see [What it can't cover](#what-it-cant-cover)). If no traffic must ever leave outside the VPN, **also** set up a killswitch outside Findr ([below](#a-killswitch-outside-findr)).

## Setting it up

Open **Settings → VPN killswitch**:

| Setting | Field | Description |
|---|---|---|
| Require a VPN for torrents | `enabled` | Turns the killswitch on. |
| VPN interface | `interfaceName` | **Required.** The network interface your VPN creates: `wg0` (WireGuard on Linux), `tun0` (OpenVPN), or `utun*` on macOS, where the number changes on every connect (a trailing `*` matches by prefix). |
| Home public IP | `homeIps` | *Optional.* Your connection's public IPv4 and IPv6 addresses, comma separated. Find them with the VPN **off** (e.g. on [ipify.org](https://www.ipify.org)). |

Incoming peer connections arrive only through the VPN, so forwarding a port on your home router no longer helps. If your VPN provider forwards a port to you, set **Settings → Torrent client → Port** to it (applies after a restart) for better speeds.

To find the interface name, connect the VPN and run `ip addr` (Linux), `ifconfig` (macOS) or `ipconfig` (Windows), and look for the interface that just appeared with your VPN's address. On macOS, `route -n get 1.1.1.1` prints the interface traffic currently uses.

The panel at the top of the section shows the live verdict: **VPN connected** with the interface and addresses, **Torrents blocked** with the reason, or **Killswitch off**. **Check now** runs every check on the spot, including a fresh public IP lookup.

## How it works

Four layers, every one of which must hold.

### 1. Binding

Every socket the torrent client opens is bound to the VPN interface's address:

- outgoing peer connections (TCP), from the VPN address of the peer's family;
- the incoming peer listener, which listens on the VPN address only;
- the DHT and UDP tracker sockets.

The address is looked up again **for every new socket**, so a connection can only be opened from an address the VPN interface holds at that moment. No timer is involved. If the tunnel drops, its address disappears: new connections fail straight away, and existing ones can no longer send.

WebTorrent has no option for this, so Findr wraps Node's `net` and `dgram` socket constructors in the process (`lib/vpn/VpnSockets.ts`). Connections to loopback, and everything while the killswitch is off, pass through untouched.

What can't be bound is turned off while the killswitch is on:

| Off | Why |
|---|---|
| HTTP(S) trackers | They are fetched with `fetch`, which can't be bound. UDP trackers, the DHT and peer exchange still find peers. |
| Web seeds | Also HTTP. |
| Magnet `xs` metadata URLs | Also HTTP. The file list still arrives from peers. |
| Local peer discovery | It announces on your LAN. |
| UPnP / NAT-PMP | They ask your router to open a port on your home connection. |

### 2. Interface and routes

The VPN interface must exist with a real address (not link-local), **and** the operating system must be routing internet traffic through it. Findr asks the OS which interface it would use to reach three public addresses: one in each half of the IPv4 space (VPNs often take over with `0.0.0.0/1` + `128.0.0.0/1` rather than a default route) and one IPv6 address. It does this by connecting a UDP socket, which sends nothing.

If either family would leave through anything other than the VPN, the killswitch trips, e.g. *IPv6 traffic would leave through en0, not the VPN*. If a family has no route at all, it can't leak, so that counts as safe.

This catches a tunnel that is still up but no longer carrying your traffic: a VPN client that reconnected badly, a default route that reverted to your router, or a VPN that tunnels IPv4 but leaves IPv6 on your home connection. In that last case, either use a VPN that tunnels IPv6 or turn IPv6 off.

These checks run:

- **the moment the routing table changes**: Findr follows `route -n monitor` on macOS and `ip monitor` on Linux (restarted if it ever exits);
- **every second** besides, in case the monitor misses something or isn't available (Windows);
- **before the torrent client starts**, and the interface again **for every socket** (layer 1).

### 3. Public IP

*Optional, only when **Home public IP** is set.* Findr asks [ipify](https://www.ipify.org) which public address its traffic comes from. If that address is one of your home addresses, or the lookup fails or takes longer than 5 seconds, the killswitch trips.

This is the only check that proves where traffic actually leaves the internet, so it catches setups the local checks can't see, such as a tunnel that exits back through your home connection. It is a network request, so it runs at startup, when the VPN settings are saved, on **Check now**, every 60 seconds while the VPN is up, and whenever the VPN has just come back, so a reconnected tunnel has to prove itself before torrents resume.

### 4. Failing closed

With the killswitch on, torrents don't run unless every check has positively passed: before the first check, without an interface configured, while the interface has no address, when a route goes elsewhere, and when the public IP lookup fails. If the installed WebTorrent ever changes so that HTTP trackers can't be turned off, downloads fail rather than run unprotected.

### When it trips

1. The torrent client is destroyed at once: every peer connection, the listener, the DHT and the tracker sockets.
2. Transfers in progress pause. Their release isn't blamed, partial files are deleted, and the download goes back to the front of the queue with *Paused until the VPN is back: …*. A transfer that had already finished keeps its files and is saved.
3. When the VPN is back, a new client starts bound to its current address, and paused downloads resume, trying the same release again.

If the VPN reconnects with a **different address**, or the killswitch is turned on while torrents are running, the client is rebuilt the same way, so nothing stays bound to an old address or runs without protection.

## What it can't cover

Findr runs inside your operating system, which has the final say on where packets go. These gaps can't be closed from inside the app:

- **DNS lookups.** Tracker and DHT bootstrap hostnames (e.g. `router.bittorrent.com`) are resolved by your system's resolver. If your VPN doesn't take over DNS, those lookups go to your ISP's resolver. That reveals that you use BitTorrent, though not what you download, and not your traffic.
- **Findr's other requests.** TMDB, Anthropic and the public IP lookup go through `fetch`, which can't be bound. They follow your system's routes: through the VPN while it is up, and outside it when it isn't. None of them carry torrent traffic.
- **Prowlarr and FlareSolverr.** They are separate programs. Their indexer searches and `.torrent` downloads are their own traffic, and Findr has no say over it.
- **Routing it can't see.** Binding fixes a packet's source address, not the interface it leaves through. If routing changes in a way the route check misses, packets could leave through your home connection carrying the VPN's address. Peers would never see your home IP (replies can't come back), but your ISP would see who the packets were addressed to.
- **The OS's own timing.** A packet already queued as a route changes may still be sent. Findr reacts within milliseconds of the routing change, not before it.
- **Other programs on the machine**, including your browser.

## A killswitch outside Findr

For a real guarantee, enforce it below Findr, so the OS itself refuses traffic that isn't on the VPN. Keep Findr's killswitch on as well: it pauses downloads cleanly instead of letting them fail, and it backs up the outer layer.

Pick whichever suits your setup:

### Your VPN client's killswitch

Most VPN apps have a *kill switch*, *lockdown mode* or *always-on VPN* option that blocks all traffic while the tunnel is down. It is the easiest option, and on macOS and Windows it is the practical one. Turn on its IPv6 leak and DNS protection too, if it has them.

### Linux: block everything but the VPN for Findr's user

Run Findr as its own user (say `findr`) and let that user's traffic out only on loopback and the VPN interface:

```sh
for ipt in iptables ip6tables; do
  $ipt -A OUTPUT -m owner --uid-owner findr -o lo -j ACCEPT
  $ipt -A OUTPUT -m owner --uid-owner findr -o wg0 -j ACCEPT
  # Replies to people using the web UI over your LAN (Findr's port)
  $ipt -A OUTPUT -m owner --uid-owner findr -p tcp --sport 34571 -j ACCEPT
  $ipt -A OUTPUT -m owner --uid-owner findr -j REJECT
done
```

This also keeps Findr's DNS lookups and API requests on the VPN, as long as the resolver is reached through the VPN or loopback. While the VPN is down, TMDB and the other services are unreachable too. Persist the rules the way your distribution does (`iptables-save`, nftables, ufw).

### Linux: a network namespace, or Docker with a VPN container

Give Findr a network where the VPN is the only way out. Then there is nothing to leak through.

- **Network namespace:** create the WireGuard interface, move it into a namespace that has no other route out, and start Findr inside it with `ip netns exec`. WireGuard documents the technique under [Routing & Network Namespace Integration](https://www.wireguard.com/netns/). To reach the web UI from outside, add a veth pair or a reverse proxy.
- **Docker:** run Findr in a container that shares a VPN container's network, such as [gluetun](https://github.com/qdm12/gluetun), using `network_mode: "service:gluetun"`. Gluetun has its own firewall killswitch. Publish Findr's port on the gluetun service.

### Prowlarr and FlareSolverr

They run from `docker/`, so the same trick works for them: add a gluetun service to your `compose.yml` and give each one `network_mode: "service:gluetun"`, moving their `ports:` onto gluetun. Their searches and `.torrent` fetches then go through the VPN too. Findr reaches Prowlarr at the same URL.
