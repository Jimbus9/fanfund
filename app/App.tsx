// A wallet a fan who has never held bitcoin can use, and the Crowdlocks they
// can join with it.
//
//   Welcome    →  New: show the 12 words → check three of them → Home
//              →  Restore: type the backup words → Home
//   Home       →  the waiting balance, Add money (QR + copy), Send out,
//                 and the Crowdlocks: each one checked before it is shown
//   Crowdlock  →  its declaration, and Sign and join in one tap
//   Add        →  any other Crowdlock, by link, checked the same way
//
// Every screen here is presentation. Anything touching keys or money goes
// through src/wallet/core.mjs, and nothing else may.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import * as Clipboard from "expo-clipboard";
import QRCode from "react-native-qrcode-svg";
// @ts-ignore — plain module shared with the chain tests
import { newWords, wordsAreValid, tidyWords, accountFromWords, waitingBalance, buildSend, signStatement } from "./src/wallet/core.mjs";
// @ts-ignore — plain module shared with the chain tests
import { STARTING_LIST, loadCrowdlock, membershipOf, committedTotal, submitJoin } from "./src/crowdlocks.mjs";
import { loadWords, saveWords, forgetWords, loadAddedCrowdlocks, saveAddedCrowdlocks, forgetAddedCrowdlocks } from "./src/storage";
import { NETWORK, IS_TEST_MONEY, chain, EXPLORER_WEB } from "./src/config";

type Screen =
  | { name: "loading" }
  | { name: "welcome" }
  | { name: "showWords"; words: string }
  | { name: "checkWords"; words: string }
  | { name: "restore" }
  | { name: "home"; words: string }
  | { name: "send"; words: string }
  | { name: "crowdlock"; words: string; url: string }
  | { name: "addCrowdlock"; words: string };

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: "loading" });

  useEffect(() => {
    loadWords().then((w) => setScreen(w ? { name: "home", words: w } : { name: "welcome" }));
  }, []);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.page}>
        <StatusBar style="dark" />
        {IS_TEST_MONEY && <Text style={s.banner}>TEST MONEY · {NETWORK} · not real bitcoin</Text>}
        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          {screen.name === "loading" && <ActivityIndicator style={{ marginTop: 80 }} />}
          {screen.name === "welcome" && <Welcome go={setScreen} />}
          {screen.name === "showWords" && <ShowWords words={screen.words} go={setScreen} />}
          {screen.name === "checkWords" && <CheckWords words={screen.words} go={setScreen} />}
          {screen.name === "restore" && <Restore go={setScreen} />}
          {screen.name === "home" && <Home words={screen.words} go={setScreen} />}
          {screen.name === "send" && <Send words={screen.words} go={setScreen} />}
          {screen.name === "crowdlock" && <CrowdlockScreen words={screen.words} url={screen.url} go={setScreen} />}
          {screen.name === "addCrowdlock" && <AddCrowdlock words={screen.words} go={setScreen} />}
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

type Go = (s: Screen) => void;

// ---------------------------------------------------------------------------

function Welcome({ go }: { go: Go }) {
  return (
    <View>
      <Text style={s.h1}>Crowdlock</Text>
      <Text style={s.p}>Your own bitcoin wallet. Nobody else holds your money — not us, not anyone.</Text>
      <Button label="Create a new wallet" onPress={() => go({ name: "showWords", words: newWords() })} />
      <Button label="I already have backup words" kind="plain" onPress={() => go({ name: "restore" })} />
    </View>
  );
}

function ShowWords({ words, go }: { words: string; go: Go }) {
  const list = words.split(" ");
  return (
    <View>
      <Text style={s.h1}>Write these down</Text>
      <Text style={s.p}>
        These 12 words are your wallet. Write them on paper, in order, and keep the paper safe.
        Anyone with them can take your money. If you lose your phone and these words, the money is gone — nobody can get it back for you.
      </Text>
      <View style={s.words}>
        {list.map((w, i) => (
          <Text key={i} style={s.word}><Text style={s.wordNum}>{i + 1}. </Text>{w}</Text>
        ))}
      </View>
      <Text style={s.note}>Do not screenshot them or save them in notes, email or cloud storage.</Text>
      <Button label="I have written them down" onPress={() => go({ name: "checkWords", words })} />
    </View>
  );
}

function CheckWords({ words, go }: { words: string; go: Go }) {
  const list = words.split(" ");
  // Three different positions, chosen once.
  const asks = useMemo(() => {
    const picks = new Set<number>();
    while (picks.size < 3) picks.add(Math.floor(Math.random() * 12));
    return [...picks].sort((a, b) => a - b);
  }, [words]);
  const [answers, setAnswers] = useState<string[]>(["", "", ""]);
  const [wrong, setWrong] = useState(false);

  const finish = async () => {
    const ok = asks.every((pos, i) => answers[i].trim().toLowerCase() === list[pos]);
    if (!ok) { setWrong(true); return; }
    await saveWords(words);
    go({ name: "home", words });
  };

  return (
    <View>
      <Text style={s.h1}>Check your paper</Text>
      <Text style={s.p}>Type these words from what you wrote down.</Text>
      {asks.map((pos, i) => (
        <View key={pos}>
          <Text style={s.label}>Word {pos + 1}</Text>
          <TextInput
            style={s.input} autoCapitalize="none" autoCorrect={false}
            value={answers[i]}
            onChangeText={(t) => { const a = [...answers]; a[i] = t; setAnswers(a); setWrong(false); }}
          />
        </View>
      ))}
      {wrong && <Text style={s.error}>That does not match. Check your paper — if a word is wrong there, go back and write them out again.</Text>}
      <Button label="Done" onPress={finish} />
      <Button label="Show the words again" kind="plain" onPress={() => go({ name: "showWords", words })} />
    </View>
  );
}

function Restore({ go }: { go: Go }) {
  const [text, setText] = useState("");
  // 12 is what this app makes; 15 to 24 come from other wallets (a Ledger
  // makes 24). All are standard, so all are accepted.
  const count = tidyWords(text).split(" ").filter(Boolean).length;
  const rightLength = [12, 15, 18, 21, 24].includes(count);
  const valid = rightLength && wordsAreValid(text);

  const finish = async () => {
    const words = tidyWords(text);
    await saveWords(words);
    go({ name: "home", words });
  };

  return (
    <View>
      <Text style={s.h1}>Restore your wallet</Text>
      <Text style={s.p}>Type your backup words, in order, with spaces between them. Usually 12 or 24.</Text>
      <TextInput
        style={[s.input, { minHeight: 120, textAlignVertical: "top" }]} multiline
        autoCapitalize="none" autoCorrect={false} value={text} onChangeText={setText}
      />
      <Text style={valid ? s.good : s.note}>
        {valid ? "Those words are valid."
          : rightLength ? `${count} words, but they don't check out — look for a misspelt word.`
          : `${count} words so far`}
      </Text>
      <Button label="Restore" disabled={!valid} onPress={finish} />
      <Button label="Back" kind="plain" onPress={() => go({ name: "welcome" })} />
    </View>
  );
}

// ---------------------------------------------------------------------------

function Home({ words, go }: { words: string; go: Go }) {
  const account = useMemo(() => accountFromWords(words, NETWORK), [words]);
  const [balance, setBalance] = useState<{ confirmed: bigint; arriving: bigint } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try { setBalance(await waitingBalance(chain, account.address)); }
    catch (e: any) { setError(String(e.message ?? e)); }
  }, [account.address]);
  useEffect(() => { refresh(); }, [refresh]);

  const remove = () => Alert.alert(
    "Remove this wallet from the phone?",
    "Only do this if your 12 words are written down. Without them the money cannot be recovered.",
    [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: async () => { await forgetWords(); await forgetAddedCrowdlocks(); go({ name: "welcome" }); } },
    ],
  );

  return (
    <View>
      <Text style={s.h1}>Waiting to lock</Text>
      <Text style={s.big}>{balance ? btc(balance.confirmed) : "…"}</Text>
      {balance && balance.arriving > 0n && <Text style={s.note}>+ {btc(balance.arriving)} arriving (not yet confirmed)</Text>}
      {error && <Text style={s.error}>Could not read the balance: {error}</Text>}
      <Button label="Refresh" kind="plain" onPress={refresh} />

      <Text style={s.h2}>Add money</Text>
      <Text style={s.p}>Send bitcoin to this address. It is yours alone.</Text>
      <View style={s.qr}><QRCode value={account.address} size={200} /></View>
      <Text style={s.mono} selectable>{account.address}</Text>
      <Button
        label={copied ? "Copied" : "Copy address"} kind="plain"
        onPress={async () => { await Clipboard.setStringAsync(account.address); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      />
      <Text style={s.note}>
        Want it automatic? Set up a standing order with a service that sends bitcoin to your own wallet, and give it this address.
      </Text>

      <Button label="Send money out" onPress={() => go({ name: "send", words })} />

      <Text style={s.h2}>Crowdlocks</Text>
      <CrowdlockList words={words} address={account.address} go={go} />
      <Button label="Add a Crowdlock" kind="plain" onPress={() => go({ name: "addCrowdlock", words })} />
      <Button label="Remove wallet from this phone" kind="danger" onPress={remove} />
    </View>
  );
}

function Send({ words, go }: { words: string; go: Go }) {
  const account = useMemo(() => accountFromWords(words, NETWORK), [words]);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [all, setAll] = useState(false);
  const [review, setReview] = useState<null | { hex: string; txid: string; fee: bigint; sent: bigint }>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const prepare = async () => {
    setBusy(true); setError(null);
    try {
      const sats = all ? "all" : BigInt(Math.round(Number(amount) * 1e8));
      const feeRate = await chain.feeRate();
      setReview(await buildSend({ account, chain, to, amount: sats, feeRate }));
    } catch (e: any) { setError(String(e.message ?? e)); }
    setBusy(false);
  };
  const confirm = async () => {
    if (!review) return;
    setBusy(true); setError(null);
    try { await chain.broadcast(review.hex); setDone(review.txid); }
    catch (e: any) { setError(String(e.message ?? e)); }
    setBusy(false);
  };

  if (done) return (
    <View>
      <Text style={s.h1}>Sent</Text>
      <Text style={s.p}>It will confirm in the next block or so.</Text>
      <Text style={s.mono} selectable>{EXPLORER_WEB}/tx/{done}</Text>
      <Button label="Back to wallet" onPress={() => go({ name: "home", words })} />
    </View>
  );

  return (
    <View>
      <Text style={s.h1}>Send money out</Text>
      <Text style={s.label}>To address</Text>
      <TextInput style={s.input} autoCapitalize="none" autoCorrect={false} value={to} onChangeText={(t) => { setTo(t); setReview(null); }} />
      <Text style={s.label}>Amount in BTC</Text>
      <TextInput
        style={s.input} keyboardType="decimal-pad" editable={!all}
        value={all ? "everything" : amount} onChangeText={(t) => { setAmount(t); setReview(null); }}
      />
      <Button label={all ? "Send a set amount instead" : "Send everything"} kind="plain" onPress={() => { setAll(!all); setReview(null); }} />

      {error && <Text style={s.error}>{error}</Text>}
      {!review && <Button label={busy ? "Checking…" : "Review"} disabled={busy || !to} onPress={prepare} />}
      {review && (
        <View style={s.panel}>
          <Text style={s.p}>Sending <Text style={s.bold}>{btc(review.sent)}</Text></Text>
          <Text style={s.p}>Network fee {btc(review.fee)}</Text>
          <Text style={s.p}>To <Text style={s.mono}>{to}</Text></Text>
          <Button label={busy ? "Sending…" : "Confirm and send"} disabled={busy} onPress={confirm} />
        </View>
      )}
      <Button label="Cancel" kind="plain" onPress={() => go({ name: "home", words })} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Crowdlocks
// ---------------------------------------------------------------------------

type Loaded = { ok: true; url: string; crowdlock: any; declarationText: string; statement: string; register: any }
  | { ok: false; url: string; problems: string[] };

async function allLinks(): Promise<string[]> {
  const added = await loadAddedCrowdlocks();
  return [...STARTING_LIST, ...added.filter((u) => !STARTING_LIST.includes(u))];
}

function CrowdlockList({ words, address, go }: { words: string; address: string; go: Go }) {
  const [items, setItems] = useState<Loaded[] | null>(null);
  useEffect(() => {
    let live = true;
    allLinks().then((links) => Promise.all(links.map((u) => loadCrowdlock(u)))).then((r) => { if (live) setItems(r); });
    return () => { live = false; };
  }, []);

  if (!items) return <ActivityIndicator style={{ marginVertical: 16 }} />;
  const here = items.filter((c) => c.ok && c.crowdlock.network === NETWORK) as Extract<Loaded, { ok: true }>[];
  const elsewhere = items.filter((c) => c.ok && c.crowdlock.network !== NETWORK) as Extract<Loaded, { ok: true }>[];
  const broken = items.filter((c) => !c.ok) as Extract<Loaded, { ok: false }>[];

  return (
    <View>
      {here.map((c) => {
        const m = membershipOf(c.register, address);
        return (
          <Pressable key={c.url} style={s.card} onPress={() => go({ name: "crowdlock", words, url: c.url })}>
            <Text style={s.cardTitle}>{c.crowdlock.name}</Text>
            <Text style={s.note}>{(c.register.members ?? []).length} signed · {(c.register.locks ?? []).length} locks</Text>
            <Text style={m ? s.good : s.link}>{m ? `You are member ${m.n}` : "Read the declaration and join →"}</Text>
          </Pressable>
        );
      })}
      {elsewhere.map((c) => (
        <View key={c.url} style={[s.card, { opacity: 0.6 }]}>
          <Text style={s.cardTitle}>{c.crowdlock.name}</Text>
          <Text style={s.note}>Uses {c.crowdlock.network === "mainnet" ? "real bitcoin" : c.crowdlock.network} — not available in this {IS_TEST_MONEY ? "test " : ""}app.</Text>
        </View>
      ))}
      {broken.map((c) => (
        <View key={c.url} style={s.card}>
          <Text style={s.error}>Refused: {c.url}</Text>
          <Text style={s.note}>{c.problems[0]}</Text>
        </View>
      ))}
    </View>
  );
}

function CrowdlockScreen({ words, url, go }: { words: string; url: string; go: Go }) {
  const account = useMemo(() => accountFromWords(words, NETWORK), [words]);
  const [c, setC] = useState<Loaded | null>(null);
  const [total, setTotal] = useState<{ sats: bigint; locks: number; members: number } | null>(null);
  const [showText, setShowText] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const loaded: Loaded = await loadCrowdlock(url);
    setC(loaded);
    if (loaded.ok) committedTotal(loaded).then(setTotal).catch(() => setTotal(null));
  }, [url]);
  useEffect(() => { load(); }, [load]);

  if (!c) return <ActivityIndicator style={{ marginTop: 60 }} />;
  if (!c.ok) return (
    <View>
      <Text style={s.h1}>Refused</Text>
      <Text style={s.p}>This Crowdlock failed its checks, so the app will not show it or let you sign anything for it.</Text>
      {c.problems.map((p, i) => <Text key={i} style={s.error}>{p}</Text>)}
      <Button label="Back" kind="plain" onPress={() => go({ name: "home", words })} />
    </View>
  );

  const me = membershipOf(c.register, account.address);
  const join = async () => {
    setBusy(true); setResult(null);
    const signature = signStatement(account, c.statement);
    const r = await submitJoin(c.crowdlock, { address: account.address, signature });
    setResult(r.ok ? { ok: true, text: `You are member ${r.n}.` } : { ok: false, text: r.error + (r.alternative ? ` You can still ${r.alternative}.` : "") });
    setBusy(false);
    if (r.ok) setTimeout(load, 4000);
  };

  return (
    <View>
      <Text style={s.h1}>{c.crowdlock.name}</Text>
      {c.crowdlock.about && <Text style={s.p}>{c.crowdlock.about}</Text>}
      {c.crowdlock.disclaimer && <Text style={s.note}>{c.crowdlock.disclaimer}</Text>}

      <View style={s.panel}>
        <Text style={s.big}>{total ? btc(total.sats) : "…"}</Text>
        <Text style={s.note}>locked and counted{total ? ` · ${total.locks} lock${total.locks === 1 ? "" : "s"}` : ""} · {(c.register.members ?? []).length} signed</Text>
        <Text style={s.good}>Checked on this phone: the declaration matches its fingerprint and the register agrees.</Text>
      </View>

      <Text style={s.h2}>The declaration</Text>
      {showText
        ? <Text style={s.declaration}>{c.declarationText}</Text>
        : <Button label="Read it in full" kind="plain" onPress={() => setShowText(true)} />}
      <Text style={s.label}>What you sign</Text>
      <Text style={s.mono}>{c.statement}</Text>

      {me
        ? <Text style={[s.good, { fontSize: 18, marginTop: 16 }]}>You are member {me.n}. Signed {me.signed}.</Text>
        : c.crowdlock.network !== NETWORK
          ? <Text style={s.note}>This Crowdlock uses a different network from this app.</Text>
          : <>
              <Text style={s.note}>Signing is free and moves no money. It proves this wallet agrees to the declaration, and the register checks it before adding you.</Text>
              <Button label={busy ? "Signing and sending…" : "Sign and join"} disabled={busy} onPress={join} />
            </>}
      {result && <Text style={result.ok ? s.good : s.error}>{result.text}</Text>}
      <Button label="Back" kind="plain" onPress={() => go({ name: "home", words })} />
    </View>
  );
}

function AddCrowdlock({ words, go }: { words: string; go: Go }) {
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[] | null>(null);

  const add = async () => {
    setBusy(true); setProblems(null);
    const loaded: Loaded = await loadCrowdlock(link);
    setBusy(false);
    if (!loaded.ok) { setProblems(loaded.problems); return; }
    const added = await loadAddedCrowdlocks();
    if (!added.includes(loaded.url) && !STARTING_LIST.includes(loaded.url)) await saveAddedCrowdlocks([...added, loaded.url]);
    go({ name: "crowdlock", words, url: loaded.url });
  };

  return (
    <View>
      <Text style={s.h1}>Add a Crowdlock</Text>
      <Text style={s.p}>Paste the link to a Crowdlock's file. It is checked on this phone, the same way the register page checks it, before it is added.</Text>
      <TextInput style={s.input} autoCapitalize="none" autoCorrect={false} placeholder="https://…/crowdlocks/name.json" value={link} onChangeText={(t) => { setLink(t); setProblems(null); }} />
      {problems && <><Text style={s.error}>Refused:</Text>{problems.map((p, i) => <Text key={i} style={s.error}>{p}</Text>)}</>}
      <Button label={busy ? "Checking…" : "Check and add"} disabled={busy || !link} onPress={add} />
      <Button label="Back" kind="plain" onPress={() => go({ name: "home", words })} />
    </View>
  );
}

// ---------------------------------------------------------------------------

function btc(sats: bigint) {
  const neg = sats < 0n; const v = neg ? -sats : sats;
  const whole = v / 100000000n; const frac = (v % 100000000n).toString().padStart(8, "0");
  return `${neg ? "-" : ""}${whole}.${frac} BTC`;
}

function Button({ label, onPress, kind = "main", disabled }: { label: string; onPress: () => void; kind?: "main" | "plain" | "danger"; disabled?: boolean }) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      style={({ pressed }) => [s.btn, kind === "plain" && s.btnPlain, kind === "danger" && s.btnDanger, (pressed || disabled) && { opacity: 0.5 }]}
    >
      <Text style={[s.btnText, kind !== "main" && s.btnTextPlain, kind === "danger" && { color: "#a00" }]}>{label}</Text>
    </Pressable>
  );
}

const RED = "#C8102E";
const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#fff" },
  banner: { backgroundColor: "#ffd84d", color: "#222", textAlign: "center", paddingVertical: 6, fontWeight: "700", fontSize: 12 },
  body: { padding: 20, paddingBottom: 60 },
  h1: { fontSize: 26, fontWeight: "800", marginTop: 12, marginBottom: 12, color: "#111" },
  h2: { fontSize: 20, fontWeight: "700", marginTop: 28, marginBottom: 8, color: "#111" },
  p: { fontSize: 16, lineHeight: 23, color: "#222", marginBottom: 10 },
  note: { fontSize: 14, lineHeight: 20, color: "#666", marginVertical: 8 },
  good: { fontSize: 14, color: "#18794e", marginVertical: 8 },
  error: { fontSize: 15, color: "#a00", marginVertical: 8 },
  big: { fontSize: 32, fontWeight: "800", color: "#111", marginBottom: 4 },
  bold: { fontWeight: "700" },
  label: { fontSize: 14, fontWeight: "600", color: "#333", marginTop: 12, marginBottom: 4 },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12, fontSize: 16, color: "#111" },
  mono: { fontFamily: "monospace", fontSize: 14, color: "#111", marginVertical: 8 },
  words: { flexDirection: "row", flexWrap: "wrap", marginVertical: 12 },
  word: { width: "50%", fontSize: 18, paddingVertical: 6, color: "#111" },
  wordNum: { color: "#888" },
  qr: { alignItems: "center", padding: 16, backgroundColor: "#fff" },
  panel: { borderWidth: 1, borderColor: "#ddd", borderRadius: 10, padding: 14, marginTop: 14 },
  btn: { backgroundColor: RED, borderRadius: 10, paddingVertical: 14, alignItems: "center", marginTop: 14 },
  btnPlain: { backgroundColor: "transparent", borderWidth: 1, borderColor: "#ccc" },
  btnDanger: { backgroundColor: "transparent", marginTop: 40 },
  btnText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  btnTextPlain: { color: "#111" },
  card: { borderWidth: 1, borderColor: "#ddd", borderRadius: 10, padding: 14, marginTop: 10 },
  cardTitle: { fontSize: 17, fontWeight: "700", color: "#111" },
  link: { fontSize: 15, color: RED, fontWeight: "600", marginTop: 4 },
  declaration: { fontSize: 15, lineHeight: 22, color: "#222", marginVertical: 8 },
});
