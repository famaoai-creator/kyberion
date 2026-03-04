---
name: switchbot-controller
description: Controls smart home devices via SwitchBot API.
status: implemented
main: dist/index.js
category: lifestyle
r: low
tags: gemini-skill,integration
last_updated: '2026-03-02'
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
npm run cli -- run switchbot-controller --action list-devices

# Turn on a specific light
npm run cli -- run switchbot-controller --action control --deviceId "XXX" --cmd "turnOn"
```
