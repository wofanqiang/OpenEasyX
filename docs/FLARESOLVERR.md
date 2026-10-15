# Connect FlareSolverr to Open EasyX

The **JavLibrary** plugin uses FlareSolverr to read its performer directory. This is a plugin setting, not a global proxy: configuring it does not route Chaturbate or other plugins through FlareSolverr.

## Use an existing instance

1. Open **Plugins → Sources & discovery**, find **JavLibrary**, and open its settings (or select **Install** if it is not installed).
2. Set **FlareSolverr URL** to the base URL that Open EasyX can reach:
   - Containers on the same Docker network: `http://flaresolverr:8191` (replace `flaresolverr` with the actual container/service name).
   - A service on another computer, or an Unraid host with port 8191 published: `http://192.168.1.10:8191` (replace the example IP with your server's LAN address).
   - A host service on Docker Desktop: `http://host.docker.internal:8191`.
3. Save the configuration, then use **Test connection**. A successful result confirms that FlareSolverr reached JavLibrary's performer directory.

Use the base URL; Open EasyX adds `/v1` automatically. A URL already ending in `/v1` is also accepted. Inside the Open EasyX container, `localhost` refers to that container, so it cannot reach a separate FlareSolverr container. Container names resolve only when both containers share a Docker network.

## Start the optional Compose service

The repository's `compose.yaml` already includes FlareSolverr under the `javlibrary` profile. From the directory containing that file, run:

```bash
docker compose --profile javlibrary up -d
```

Then configure the JavLibrary plugin with `http://flaresolverr:8191`. Both services share the Compose network; publishing port 8191 to the host is unnecessary for this setup. Starting the service does not automatically install or configure the plugin.

## Check connectivity

For the bundled service, run this from the Compose directory. For your own instance, replace the URL with the same base URL you entered in the plugin:

```bash
docker compose exec open-easyx node -e "fetch('http://flaresolverr:8191/').then(async r => { console.log(r.status, await r.text()); if (!r.ok) process.exitCode = 1; }).catch(e => { console.error(e.message); process.exitCode = 1; })"
```

- **Connection refused / fetch failed:** check that FlareSolverr is running, the hostname resolves from Open EasyX, and the port is reachable between the containers or hosts.
- **HTTP 404:** verify the URL and any reverse-proxy path. Use the base URL, not an administration page.
- **Challenge not cleared / JavLibrary unavailable:** connectivity succeeded but the provider request failed. Inspect `docker compose --profile javlibrary logs --tail 100 flaresolverr` (or your existing instance's logs), update FlareSolverr if needed, then test again.

See the [FlareSolverr documentation](https://github.com/FlareSolverr/FlareSolverr#usage) for service configuration and API details.
