// English strings, desktop-connection. Same keys as ../zh/desktop-connection.ts (typecheck enforces it).
export const desktopConnection = {
  "desktop.connection.aSelfHostedRendezvousServer":
    "A self-hosted rendezvous server or your own domain. Leave blank to use the default {defaultRelayUrl}. Ideally open the phone site from this address too and add it to the home screen.",
  "desktop.connection.addressesThePhoneKnows": "Addresses the phone knows",
  "desktop.connection.alcaLinkIsntOnYet":
    "Alca Link isn't on yet. Start Alca with a rendezvous server to set up connections.",
  "desktop.connection.autoRepair": "Auto-repair",
  "desktop.connection.checkPassedThePhoneCan": "Check passed: the phone can find this computer.",
  "desktop.connection.connectingToTheRelay": "Connecting to the relay…",
  "desktop.connection.direct": " + {directUrlsCount} direct",
  "desktop.connection.directAddress": "Direct address",
  "desktop.connection.directAddressTailscaleLan": "Direct address (Tailscale/LAN)",
  "desktop.connection.everyMinLast": "Every {selfCheckMinutes} min, last {lastCheckAt}{p2}",
  "desktop.connection.httpsAlcaYourDomain": "https://alca.your-domain",
  "desktop.connection.httpsRelayYourDomain": "https://relay.your-domain",
  "desktop.connection.leaveBlankToUseThe":
    "Leave blank to use the built-in {defaultSiteUrl}: the phone signs in there, and this computer signs in with Google through it.",
  "desktop.connection.listeningOnTheLanTurn":
    "Listening on the LAN: {p0}. Turn it into wss:// with tailscale serve and enter it here; the phone tries the direct route first.",
  "desktop.connection.mailboxId": "Mailbox ID",
  "desktop.connection.notNeededYet": "Not needed yet",
  "desktop.connection.notSaved": "Not saved",
  "desktop.connection.ok": ", OK",
  "desktop.connection.optional": "Optional",
  "desktop.connection.reRegistering": "Re-registering…",
  "desktop.connection.savedConnectedPhonesAlreadyHave":
    "Saved; connected phones already have the new address, no need to pair again.",
  "desktop.connection.selfCheck": "Self-check",
  "desktop.connection.selfHostedAlcaSite": "Self-hosted Alca site",
  "desktop.connection.startWithLinkLan4318":
    "Start with --link-lan 4318 to listen on the LAN; then turn it into wss:// with tailscale serve and enter it here; the phone tries the direct route first.",
  "desktop.connection.theMailboxIdIsDerived":
    "The mailbox ID is derived from this computer's key and doesn't change across restarts or networks; the relay only forwards encrypted content.",
  "desktop.connection.thePhoneCanFindThis": "The phone can find this computer",
  "desktop.connection.theRelayCantBeReached": "The relay can't be reached from outside",
  "desktop.connection.theRelayCantFindThis": "The relay can't find this computer",
  "desktop.connection.theRelayIsntResponding": "The relay isn't responding",
  "desktop.connection.theSitesGoogleClientId": "The site's Google client ID",
  "desktop.connection.thisBuildHasNoBuilt":
    "This build has no built-in site. Enter the phone site you deployed and its Google web client ID (see DEPLOY.md).",
  "desktop.connection.timesLast": "{repairs} times, last {lastRepairAt}",
  "desktop.connection.via": "Via {relayUrl}{p1}",
  "desktop.connection.wssYourMacTailnetTs": "wss://your-mac.tailnet.ts.net",
  "desktop.connection.yourOwnAddress": ", your own address",
  "desktop.connection.yourOwnStableAddress": "Your own stable address",
};
