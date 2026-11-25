# VPP + vppcfg + BIRD lab for the @lstrandos/vppcfg end-to-end test.
FROM debian:bookworm-slim
ARG VPP_VERSION=26.06-release
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg iproute2 procps bird2 \
      python3 python3-pip python3-venv git \
 && curl -fsSL https://packagecloud.io/fdio/release/gpgkey | gpg --dearmor -o /usr/share/keyrings/fdio.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/fdio.gpg] https://packagecloud.io/fdio/release/debian/ bookworm main" \
      > /etc/apt/sources.list.d/fdio.list \
 && apt-get update \
 && dpkg-divert --local --rename --add /usr/sbin/sysctl && ln -s /bin/true /usr/sbin/sysctl \
 && apt-get install -y --no-install-recommends "vpp=$VPP_VERSION" "vpp-plugin-core=$VPP_VERSION" \
      "libvppinfra=$VPP_VERSION" "python3-vpp-api=$VPP_VERSION" \
 && rm /usr/sbin/sysctl && dpkg-divert --local --rename --remove /usr/sbin/sysctl \
 && rm -rf /var/lib/apt/lists/*
# vppcfg as on the routers: its own venv, wrapper in /usr/local/bin
ARG VPPCFG_REF=main
RUN python3 -m venv --system-site-packages /opt/vppcfg \
 && /opt/vppcfg/bin/pip install --no-cache-dir "git+https://git.ipng.ch/ipng/vppcfg.git@${VPPCFG_REF}" \
 && ln -s /opt/vppcfg/bin/vppcfg /usr/local/bin/vppcfg
COPY startup.conf /etc/vpp/startup.conf
COPY bird.conf /etc/bird/bird.conf
COPY vppcfg.yaml /etc/vpp/vppcfg.yaml
COPY start.sh /usr/local/bin/start.sh
CMD ["start.sh"]
