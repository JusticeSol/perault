import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  injectedWallet,
  metaMaskWallet,
  rabbyWallet,
  subWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import type { Chain } from "viem";
import { createConfig, http, type Transport } from "wagmi";
import { networks, walletConnectProjectId } from "./env";

const appName = "Perault";

// Named wallets find their own extension by its EIP-6963 announcement (io.metamask,
// app.subwallet, …), so with several wallet extensions installed the user picks one by name and
// the app talks to exactly that one. The generic "injected" entry only uses window.ethereum,
// which whichever extension loaded last may have taken over.
// With a WalletConnect project id, mobile wallets via QR are offered too.
const browserWallets = [metaMaskWallet, rabbyWallet, subWallet];
const connectors = connectorsForWallets(
  walletConnectProjectId
    ? [
        { groupName: "Popular", wallets: [...browserWallets, walletConnectWallet] },
        { groupName: "More", wallets: [injectedWallet] },
      ]
    : [
        { groupName: "Browser wallets", wallets: browserWallets },
        { groupName: "Other", wallets: [injectedWallet] },
      ],
  { appName, projectId: walletConnectProjectId ?? "not-set" },
);

const chains = networks.map((n) => n.chain) as [Chain, ...Chain[]];

export const wagmiConfig = createConfig({
  chains,
  connectors,
  transports: Object.fromEntries(chains.map((c) => [c.id, http()])) as Record<number, Transport>,
  ssr: true,
});
