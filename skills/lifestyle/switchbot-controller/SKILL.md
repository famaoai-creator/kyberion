---
name: switchbot-controller
description: Controls smart home devices via SwitchBot API.
status: implemented
main: scripts/main.cjs
category: lifestyle
r: low
---

# SwitchBot Controller

Enables physical world interaction through SwitchBot smart devices.

## Actions
- `list-devices`: List all registered devices and scenes.
- `control`: Send a command to a specific device.

## Arguments
- `--action`: `list-devices` or `control`.
- `--deviceId`: (Required for `control`) The ID of the device.
- `--cmd`: (Required for `control`) The command (e.g., `turnOn`, `turnOff`, `press`).
- `--param`: (Optional) Command parameters.

## Examples
```bash
# List all your devices
node scripts/cli.cjs run switchbot-controller --action list-devices

# Turn on a specific light
node scripts/cli.cjs run switchbot-controller --action control --deviceId "XXX" --cmd "turnOn"
```
