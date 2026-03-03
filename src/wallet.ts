import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { create, decrypt } from "web3-eth-accounts";
import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
  type Account,
  type Transport,
  type Chain,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DATA_DIR, WALLET_PATH } from "./constants.js";
import type { ChainConfig } from "./types.js";
import type { Logger } from "./logger.js";

export interface WalletContext {
  account: Account;
  publicClient: PublicClient<Transport, Chain>;
  walletClient: WalletClient<Transport, Chain, Account>;
}

/** Create a new wallet and write keystore to disk. Returns the address. */
export async function createWallet(
  pass: string,
  logger: Logger,
): Promise<Address> {
  mkdirSync(DATA_DIR, { recursive: true });
  const newAccount = create();
  const keystore = await newAccount.encrypt(pass);
  writeFileSync(WALLET_PATH, JSON.stringify(keystore, null, 2));
  logger.info("Wallet saved to " + WALLET_PATH);
  const account = privateKeyToAccount(newAccount.privateKey as `0x${string}`);
  return account.address;
}

/** Import a wallet from a private key. Returns the address. */
export async function importWallet(
  privateKey: string,
  pass: string,
  logger: Logger,
): Promise<Address> {
  mkdirSync(DATA_DIR, { recursive: true });
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  // web3-eth-accounts create() returns an object with encrypt(); we need to build one from the key
  const tempAccount = create();
  // Overwrite with the imported key by creating a proper account object
  const importedAccount = {
    ...tempAccount,
    address: account.address,
    privateKey: privateKey,
  };
  const keystore = await importedAccount.encrypt(pass);
  writeFileSync(WALLET_PATH, JSON.stringify(keystore, null, 2));
  logger.info("Wallet saved to " + WALLET_PATH);
  return account.address;
}

/** Decrypt keystore and return the private key. */
export async function exportWallet(
  pass: string,
  logger: Logger,
): Promise<string> {
  if (!existsSync(WALLET_PATH)) {
    throw new Error("No wallet found. Run 'wallet create' or 'wallet import' first.");
  }
  const keystoreJson = readFileSync(WALLET_PATH, "utf-8");
  const keystore = JSON.parse(keystoreJson);
  const decrypted = await decrypt(keystore, pass);
  logger.info("Wallet decrypted successfully");
  return decrypted.privateKey;
}

/** Load wallet from keystore and return a full WalletContext. */
export async function loadWallet(
  pass: string,
  chainConfig: ChainConfig,
  rpcUrl: string,
  logger: Logger,
): Promise<WalletContext> {
  if (!existsSync(WALLET_PATH)) {
    throw new Error("No wallet found. Run 'wallet create' or 'wallet import' first.");
  }
  const keystoreJson = readFileSync(WALLET_PATH, "utf-8");
  const keystore = JSON.parse(keystoreJson);
  const decrypted = await decrypt(keystore, pass);
  const privateKey = decrypted.privateKey as `0x${string}`;

  const account = privateKeyToAccount(privateKey);
  logger.info(`Wallet address: ${account.address}`);

  const transport = http(rpcUrl);

  const publicClient = createPublicClient({
    chain: chainConfig.viemChain,
    transport,
  }) as PublicClient<Transport, Chain>;

  const walletClient = createWalletClient({
    account,
    chain: chainConfig.viemChain,
    transport,
  }) as WalletClient<Transport, Chain, Account>;

  return { account, publicClient, walletClient };
}

/** Get wallet address from keystore without needing the password. Returns null if no wallet. */
export function getWalletAddress(): Address | null {
  if (!existsSync(WALLET_PATH)) return null;
  try {
    const keystoreJson = readFileSync(WALLET_PATH, "utf-8");
    const keystore = JSON.parse(keystoreJson);
    if (keystore.address) {
      // web3-eth-accounts stores address without 0x prefix
      const addr = keystore.address.startsWith("0x")
        ? keystore.address
        : `0x${keystore.address}`;
      return addr as Address;
    }
    return null;
  } catch {
    return null;
  }
}
