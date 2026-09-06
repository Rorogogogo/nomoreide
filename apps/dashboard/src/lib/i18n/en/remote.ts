export const en_remote = {
  "remote.title": "Control this machine from your phone",
  "remote.pageIntro":
    "Pair this machine with your phone to start and stop its services, read logs, watch CI and agent usage, and drive an agent — from anywhere. Your machine dials out; nothing listens for incoming connections.",
  "remote.intro": "Pair this machine with your NoMoreIDE account to start and stop services, read logs, and watch an agent terminal from your phone.",
  "remote.pair": "Pair this machine",
  "remote.pairing": "Waiting for approval…",
  "remote.codeLabel": "Enter this code on your phone",
  "remote.openLink": "Or open this link",
  "remote.pairedAs": "Paired as {name}",
  "remote.connected": "Connected. This machine is reachable from your phone.",
  "remote.notConnected": "Paired, but not connected yet.",
  "remote.unpair": "Unpair this machine",
  "remote.unpairNote": "Removes the credential from this machine. The device stays on your account until you revoke it from your phone.",
  "remote.expired": "That code expired. Start again.",
  "remote.failed": "Pairing could not be completed.",
  "remote.safety":
    "Pairing lets your account start and stop services on this machine, read their logs, and open terminals on it — including a shell, which can run anything you could run yourself. Set NOMOREIDE_REMOTE_SHELL=0 to withhold the shell and keep the rest.",
  "remote.approve": "Approve in your account",
  "remote.approveHint": "Opens NoMoreIDE in a new tab. If you are already signed in there, that is the whole of it — no code to type.",
  "remote.scan": "Point your phone's camera at this",
  "remote.scanAlt": "QR code linking to the pairing page for this machine",
  "remote.orType": "Or type this code on your phone",
} as const;
