#!/bin/bash
# Boot like the routers: bootstrap.vpp execs the vppcfg render of the YAML.
# The render is made only on first start; after that VPP boots from whatever
# vppcfg.vpp holds (as on a router after `docker restart` = reboot).
set -eu
ip netns del dataplane 2>/dev/null || true
ip netns add dataplane
for p in p0 p1; do
  ip link del $p 2>/dev/null || true
  ip link add $p type veth peer name $p-peer; ip link set $p up; ip link set $p-peer up
done
mkdir -p /etc/vpp/config /var/log/vpp /run/vpp /run/bird
printf 'create host-interface name p0\ncreate host-interface name p1\n' > /etc/vpp/config/head.vpp
[ -s /etc/vpp/config/vppcfg.vpp ] || vppcfg plan --novpp -c /etc/vpp/vppcfg.yaml -o /etc/vpp/config/vppcfg.vpp
rm -f /run/lab-ready /run/bird/bird.ctl
printf 'exec /etc/vpp/config/head.vpp\nexec /etc/vpp/config/vppcfg.vpp\n' > /etc/vpp/bootstrap.vpp
vpp -c /etc/vpp/startup.conf &
for i in $(seq 1 60); do vppctl show version >/dev/null 2>&1 && break; sleep 0.5; done
sleep 3
ip netns exec dataplane bird -c /etc/bird/bird.conf -s /run/bird/bird.ctl
ln -sf /run/bird/bird.ctl /run/bird.ctl
touch /run/lab-ready
wait
