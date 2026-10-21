import { useState } from 'react'
import type { ChannelConfig, SendMode } from '@shared/types'
import { Confirm, Switch } from '../ui'

/** The "Allow sending" switch. Turning it on asks once; turning it off is immediate. */
export function AllowSendSwitch({ cfg, mode }: { cfg: ChannelConfig; mode: SendMode }): JSX.Element {
  const [ask, setAsk] = useState(false)
  return (
    <>
      <Switch
        on={cfg.allowSend}
        disabled={!cfg.enabled}
        accent
        label={`Allow sending to ${cfg.login}`}
        onChange={(v) => (v ? setAsk(true) : void window.api.updateChannel(cfg.login, { allowSend: false }))}
      />
      {ask && (
        <Confirm
          title={`Allow messages in #${cfg.login}?`}
          confirmLabel="Allow sending"
          body={`With this on, the app may post to #${cfg.login} as your Twitch account${mode === 'approval' ? ' after you approve each message' : ' automatically'}. Make sure the streamer and mods are fine with it.`}
          onCancel={() => setAsk(false)}
          onConfirm={() => {
            void window.api.updateChannel(cfg.login, { allowSend: true })
            setAsk(false)
          }}
        />
      )}
    </>
  )
}
