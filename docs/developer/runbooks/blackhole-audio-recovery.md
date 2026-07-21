# BlackHole audio recovery runbook

## 状態確認

```bash
pnpm meeting:preflight --mission <MISSION_ID> --json
pnpm voice:route:list -- --json
pnpm voice:route:probe -- --json
pnpm doctor:meeting
```

receiptで次を確認します。

- input/output device UIDとdisplay name
- input/output process alive、unexpected EOF、device disconnect
- queue depth、dropped chunks、underrun、RMS、clipping
- TTS first audio、capture duration、STT final、similarity

## 典型的な復旧

`BLACKHOLE_DRIVER_REQUIRED` はoperatorがBlackHole 2chをインストールし、Audio MIDI Setupで表示を確認します。`COREAUDIO_DEVICE_INVENTORY_EMPTY` はdevice reconnect後にUIDを再取得します。同名deviceが複数ある場合はUIDを指定します。sample rate mismatchはrequestのformatとdevice capabilityを揃え、暗黙resampleに依存しません。

`captured audio is silent` または出力chunksが0の場合、物理speakerやmacOS default outputを切り替えて再試行しません。CoreAudio output bridgeのUID、captureのexact device、permission、consentを順に確認します。

## orphan/lease cleanup

まず会議を停止し、emergency stopを実行します。通常のcloseが失敗した場合でもprocess groupとleaseはcleanup pathで解放されます。stale leaseはTTL経過後にdoctorで確認します。Audio MIDI設定を自動変更せず、必要ならoperatorが手動で復元します。

## rollback

loopback経路の無効化は `--bus stub` または会議runtimeのaudio bus設定変更で行います。新しいCoreAudio helperを削除する前に、receipt・trace・leaseが残っていないことを確認します。旧default-output-switch bridgeは互換機能であり、loopbackの正規経路には戻しません。
