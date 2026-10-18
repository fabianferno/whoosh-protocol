import { formatEther } from 'viem';
import { Gateway, type GatewayEvent } from '../arkiv/gateway.ts';
import { SdkStore } from '../arkiv/sdkStore.ts';
import { loadOrCreateWallet } from '../arkiv/wallet.ts';
import type { GroupKeys } from '../packet/keys.ts';
import { IdbOutbox } from '../storage/outbox.ts';

export interface ArkivDeps {
  getKeys(): GroupKeys | null;
  /** True if this device already holds the message (heard over the air or already pulled). */
  hasLocally(mid: string): boolean;
  /** Show a packet pulled from Arkiv in the inbox. */
  deliver(packet: Uint8Array): Promise<void>;
  /** Rebroadcast a packet over sound. */
  replay(packet: Uint8Array): Promise<void>;
}

const FAUCET = 'https://hub.arkiv.network/faucet';
const EXPLORER = 'https://tiramisu.explorer.arkiv.network';

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** The Arkiv tab: a burner wallet, balance, and the two gateway switches. */
export function mountArkivPanel(deps: ArkivDeps): { settle(packet: Uint8Array): void; groupChanged(): void } {
  const status = el('arkivStatus');
  const address = el('walletAddress');
  const balance = el('walletBalance');
  const settleToggle = el<HTMLInputElement>('settleToggle');
  const watchToggle = el<HTMLInputElement>('watchToggle');
  const logList = el<HTMLUListElement>('arkivLog');

  let store: SdkStore | null = null;
  let gateway: Gateway | null = null;
  let stopWatch: (() => void) | null = null;
  let replays: Promise<void> = Promise.resolve();

  function log(text: string, href?: string): void {
    const li = document.createElement('li');
    const p = document.createElement('p');
    if (href) {
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = text;
      p.append(a);
    } else {
      p.textContent = text;
    }
    const time = document.createElement('small');
    time.textContent = new Date().toLocaleTimeString();
    li.append(p, time);
    logList.prepend(li);
    while (logList.children.length > 20) logList.lastElementChild?.remove();
  }

  function onEvent(event: GatewayEvent): void {
    switch (event.kind) {
      case 'written':
        log(`Settled ${event.mid} (${event.hops} hop${event.hops === 1 ? '' : 's'})`, `${EXPLORER}/tx/${event.txHash}`);
        void refreshBalance();
        break;
      case 'queued':
        log(`Queued ${event.mid}: ${event.reason}`);
        break;
      case 'pulled':
        log(`Pulled ${event.count} message${event.count === 1 ? '' : 's'} from Arkiv`);
        break;
      case 'error':
        log(`Arkiv error: ${event.error.message}`);
        break;
      case 'duplicate':
        break;
    }
  }

  async function refreshBalance(): Promise<void> {
    if (!store) return;
    try {
      const wei = await store.balance();
      balance.textContent = wei === 0n ? '0 GLM. Fund this address at the faucet before settling.' : `${Number(formatEther(wei)).toFixed(4)} GLM`;
    } catch {
      balance.textContent = 'Balance unavailable (offline?)';
    }
  }

  function startWatch(): void {
    stopWatch?.();
    stopWatch = null;
    if (!gateway || !watchToggle.checked) return;
    stopWatch = gateway.start((packets) => {
      for (const packet of packets) {
        replays = replays.then(async () => {
          await deps.deliver(packet);
          await deps.replay(packet);
        }).catch((error: Error) => log(`Replay failed: ${error.message}`));
      }
    });
  }

  function rebuild(): void {
    stopWatch?.();
    stopWatch = null;
    gateway = null;
    const keys = deps.getKeys();
    if (!store || !keys) {
      status.textContent = 'Set up a group key on the Group tab first.';
      return;
    }
    status.textContent = 'Gateway ready. Turn on a switch below.';
    gateway = new Gateway({ store, keys, outbox: new IdbOutbox(), hasLocally: deps.hasLocally, onEvent });
    if (settleToggle.checked) void gateway.flush();
    startWatch();
  }

  settleToggle.addEventListener('change', () => {
    if (settleToggle.checked && gateway) void gateway.flush();
    if (settleToggle.checked && !gateway) status.textContent = 'Set up a group key on the Group tab first.';
  });
  watchToggle.addEventListener('change', startWatch);
  el('refreshBalanceBtn').addEventListener('click', () => void refreshBalance());
  el<HTMLAnchorElement>('faucetLink').href = FAUCET;

  void loadOrCreateWallet().then((wallet) => {
    store = new SdkStore(wallet.privateKey);
    address.textContent = wallet.address;
    if (!wallet.persisted) log('This wallet could not be saved and will be lost when the app closes.');
    void refreshBalance();
    rebuild();
  });

  return {
    settle(packet) {
      if (settleToggle.checked && gateway) void gateway.settle(packet);
    },
    groupChanged: rebuild,
  };
}
