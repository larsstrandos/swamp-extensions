# linux-cp, VRFs and Bird: known pitfalls

Verified on VPP 26.10 with linux-cp/linux-nl and Bird 2.0.12.

## linux-nl and tables

- linux-nl maps Linux kernel table N to VPP FIB table N. A Bird `vrf` protocol
  with `kernel table N` therefore lands in VPP table N, but only if that VPP table
  exists. Check with `tables`.
- Enslaving the Linux TAP (the lcp host interface) to a Linux VRF does **not**
  move the VPP interface. Its connected prefix leaks into VPP table 0. You also
  need `set interface ip table <if> N` (and `set interface ip6 table`).
  Symptom: in `interfaces`, the VPP interface has `tableId: 0` while the Linux
  side is in a VRF.
- VPP refuses `set interface ip table` while the interface has addresses. The
  order is: remove the addresses, set the table, add the addresses back.
- `lcp-sync` does not mirror a VPP table change into a Linux VRF. `lcp` shows
  whether lcp-sync is on; whatever it shows, set the Linux VRF yourself.
- Set `sysctl net.ipv6.conf.all.keep_addr_on_down=1`. Without it, enslaving an
  interface to a VRF flushes its IPv6 addresses.

## Bird

- If Bird announces the BGP link prefix back to the peer, it shadows the peer's
  connected route, and IPv6 route installs then fail with
  `Netlink: No route to host`. Limit the `direct` protocol to the LAN
  interfaces.

## Reading the FIB

- `glean` path: a connected subnet. VPP sends ARP/ND for the destination.
- `receive` path: a local address of the node.
- `drop` path: no route; `0.0.0.0/0 drop` means there is no default route in
  that table.
- `via NH IF`: a resolved adjacency. The next hop is in the neighbor table.
- `packets` / `bytes` per prefix are counted on the load-balance object, so
  they show which prefixes actually carry traffic.

## Error counters that are normal

`health` ignores these even though VPP files them under severity `error`:

- `af-packet-input`: `timed out block`, `total received block`
- `ethernet-input`: `no error`

Worth looking at when they rise: `ip4-input`/`ip6-input` `source lookup miss`
(uRPF or a missing table), `ip4-glean`/`ip6-glean` (address resolution failing),
`*-rewrite` `MTU exceeded`, and `rx-miss` / `rx-error` on interfaces (NIC
queues/buffers).
