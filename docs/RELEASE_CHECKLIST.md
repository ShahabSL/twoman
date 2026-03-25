# Release Checklist

- Create `host/app/config.php` from `host/app/config.sample.php`
- Create `hidden_server/config.json` from `hidden_server/config.sample.json`
- Create `local_client/config.json` from `local_client/config.sample.json`
- Verify no real tokens are present in tracked files
- Verify `host/storage/` is empty or absent
- Verify `TWOMAN_TRACE` is not enabled in production
- Verify broker health responds on `/twoman/bridge/v2/health`
- Verify SOCKS egress through the helper
- Verify HTTP egress through the helper

