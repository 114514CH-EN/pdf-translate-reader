/**
 * The small cards that open over the pet when you play with it: rock–paper–scissors,
 * a glossary quiz, the fortune of the day, and the bond page (levels and charms).
 * The rules live in play.ts; this file only draws them.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api } from '../api/client';
import { Icon } from '../components/Icon';
import {
  buildQuiz,
  charmUnlocked,
  drewFortune,
  fortuneOf,
  HAND_FACE,
  HAND_NAME,
  HANDS,
  judge,
  LEVELS,
  levelOf,
  playedRps,
  QUIZ_MIN,
  quizDone,
  quizPool,
  WIN_CAP,
  type Bond,
  type CharmId,
  type Hand,
  type QuizCard,
} from './play';

export type PlayMode = 'rps' | 'quiz' | 'fortune' | 'bond';

interface Props {
  mode: PlayMode;
  bond: Bond;
  docId: string | null;
  style: CSSProperties;
  onBond: (b: Bond) => void;
  onClose: () => void;
  /** the pet reacts: happy (hearts + hop), impressed (stars), or sulky */
  react: (how: 'happy' | 'wow' | 'sad') => void;
}

const TITLE: Record<PlayMode, string> = { rps: '猜拳', quiz: '考考术语', fortune: '今日签', bond: '亲密度' };

/** The ornament over the pet's head. */
export function Charm({ id }: { id: CharmId }) {
  if (id === 'none') return null;
  return (
    <svg className={`pet-charm-art is-${id}`} viewBox="0 0 24 24" aria-hidden="true">
      {id === 'sprout' && (
        <>
          <path d="M12 22v-9" className="c-stem" />
          <path d="M12 14C12 9 8.5 6.5 4 7c0 4.5 3 7.5 8 7Z" className="c-leaf" />
          <path d="M12 12c0-4 2.5-6.5 7-6.5 0 4-2.5 7-7 6.5Z" className="c-leaf" />
        </>
      )}
      {id === 'star' && <path d="M12 3.2l2.6 5.5 6 .8-4.4 4.2 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 9.5l6-.8Z" className="c-gold" />}
      {id === 'bow' && (
        <>
          <path d="M12 12 4.5 7.2c-1.2-.8-2 0-2 1.2v7.2c0 1.2.8 2 2 1.2Z" className="c-rose" />
          <path d="M12 12l7.5-4.8c1.2-.8 2 0 2 1.2v7.2c0 1.2-.8 2-2 1.2Z" className="c-rose" />
          <circle cx="12" cy="12" r="2.6" className="c-rose-dark" />
        </>
      )}
      {id === 'crown' && (
        <>
          <path d="M3.5 18.5 2.5 8l5.2 4.2L12 5l4.3 7.2L21.5 8l-1 10.5Z" className="c-gold" />
          <circle cx="12" cy="14.6" r="1.5" className="c-gem" />
        </>
      )}
      {id === 'halo' && <ellipse cx="12" cy="12" rx="9" ry="3.6" className="c-halo" />}
    </svg>
  );
}

function Rps({ bond, onBond, react }: Pick<Props, 'bond' | 'onBond' | 'react'>) {
  const [round, setRound] = useState<{ mine: Hand; theirs: Hand; result: 'win' | 'lose' | 'draw'; treat: boolean; n: number } | null>(null);
  const [thinking, setThinking] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const play = (mine: Hand) => {
    if (thinking) return;
    setThinking(true);
    timer.current = window.setTimeout(() => {
      const theirs = HANDS[Math.floor(Math.random() * 3)];
      const result = judge(mine, theirs);
      const r = playedRps(bond, result);
      onBond(r.bond);
      setRound((p) => ({ mine, theirs, result, treat: r.treat, n: (p?.n ?? 0) + 1 }));
      setThinking(false);
      react(result === 'win' ? 'wow' : result === 'lose' ? 'happy' : 'sad');
    }, 520);
  };
  const verdict = round ? (round.result === 'win' ? '你赢了' : round.result === 'lose' ? '我赢啦' : '平手') : '';
  return (
    <>
      <div className={`pet-rps-stage${thinking ? ' is-thinking' : ''}`} aria-live="polite">
        {thinking ? (
          <span className="pet-rps-shake" aria-label="出拳中">
            ✊
          </span>
        ) : round ? (
          <div className="pet-rps-result" key={round.n}>
            <span className="pet-rps-side">
              <span className="pet-rps-hand">{HAND_FACE[round.mine]}</span>
              <span>你</span>
            </span>
            <strong className={`pet-rps-verdict is-${round.result}`}>{verdict}</strong>
            <span className="pet-rps-side">
              <span className="pet-rps-hand">{HAND_FACE[round.theirs]}</span>
              <span>小页</span>
            </span>
          </div>
        ) : (
          <span className="pet-play-hint">石头、剪刀、布——你先出</span>
        )}
      </div>
      {round?.treat && !thinking && <div className="pet-play-note">赢到一份零食</div>}
      {round?.result === 'win' && !round.treat && !thinking && <div className="pet-play-note">今天的零食已经赢满 {WIN_CAP} 份了</div>}
      <div className="pet-play-choices">
        {HANDS.map((h) => (
          <button key={h} type="button" className="pet-chip-btn" disabled={thinking} onClick={() => play(h)}>
            {HAND_NAME[h]}
          </button>
        ))}
      </div>
      <div className="pet-play-foot">
        战绩 {bond.rps.win} 胜 {bond.rps.lose} 负 {bond.rps.draw} 平
      </div>
    </>
  );
}

function Quiz({ bond, docId, onBond, react }: Pick<Props, 'bond' | 'docId' | 'onBond' | 'react'>) {
  const [cards, setCards] = useState<QuizCard[] | null>(null);
  const [state, setState] = useState<'loading' | 'few' | 'error' | 'ready'>('loading');
  const [have, setHave] = useState(0);
  const [i, setI] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [right, setRight] = useState(0);
  const [done, setDone] = useState<{ treat: boolean } | null>(null);
  const [seed, setSeed] = useState(0);
  const bondRef = useRef(bond);
  bondRef.current = bond;

  useEffect(() => {
    let alive = true;
    setState('loading');
    setI(0);
    setPicked(null);
    setRight(0);
    setDone(null);
    if (!docId) {
      setState('few');
      setHave(0);
      return;
    }
    api
      .listGlossary(docId)
      .then((terms) => {
        if (!alive) return;
        const pool = quizPool(terms);
        setHave(pool.length);
        const q = buildQuiz(pool);
        setCards(q);
        setState(q.length ? 'ready' : 'few');
      })
      .catch(() => alive && setState('error'));
    return () => {
      alive = false;
    };
  }, [docId, seed]);

  if (state === 'loading') return <div className="pet-play-hint">翻术语表中…</div>;
  if (state === 'error') return <div className="pet-play-hint">术语表没读出来，过一会儿再试</div>;
  if (state === 'few' || !cards)
    return (
      <div className="pet-play-hint">
        {docId ? `这篇文档的术语表里只有 ${have} 个可以考的词，至少要 ${QUIZ_MIN} 个。先在侧栏「术语」里攒几个吧。` : '先打开一篇文档，我才有词可以考你。'}
      </div>
    );

  if (done)
    return (
      <>
        <div className="pet-quiz-score">
          <strong>
            {right} / {cards.length}
          </strong>
          <span>{right === cards.length ? '全对，厉害！' : right >= cards.length - 1 ? '差一点就全对了' : right >= cards.length / 2 ? '还不错，再来一轮更稳' : '这些词还生，多看两眼'}</span>
        </div>
        {done.treat && <div className="pet-play-note">奖励一份零食</div>}
        <div className="pet-play-choices">
          <button type="button" className="pet-chip-btn primary" onClick={() => setSeed((s) => s + 1)}>
            再来一轮
          </button>
        </div>
      </>
    );

  const card = cards[i];
  const choose = (k: number) => {
    if (picked !== null) return;
    setPicked(k);
    const ok = k === card.answer;
    if (ok) setRight((r) => r + 1);
    react(ok ? 'wow' : 'sad');
  };
  const next = () => {
    if (i + 1 < cards.length) {
      setI(i + 1);
      setPicked(null);
      return;
    }
    const r = quizDone(bondRef.current, right, cards.length);
    onBond(r.bond);
    setDone({ treat: r.treat });
    if (right >= cards.length - 1) react('happy');
  };
  return (
    <>
      <div className="pet-quiz-count">
        第 {i + 1} / {cards.length} 题 · {card.side === 'src' ? '选出译名' : '选出原文'}
      </div>
      <div className="pet-quiz-ask">{card.ask}</div>
      <div className="pet-quiz-options" role="group" aria-label="选项">
        {card.options.map((o, k) => (
          <button
            key={k}
            type="button"
            className={['pet-quiz-option', picked !== null && k === card.answer ? 'is-right' : '', picked === k && k !== card.answer ? 'is-wrong' : ''].filter(Boolean).join(' ')}
            disabled={picked !== null}
            onClick={() => choose(k)}
          >
            {o}
          </button>
        ))}
      </div>
      {picked !== null && (
        <div className="pet-play-choices">
          <span className="pet-play-note">{picked === card.answer ? '答对了' : '记一下正确的那个'}</span>
          <button type="button" className="pet-chip-btn primary" onClick={next} autoFocus>
            {i + 1 < cards.length ? '下一题' : '看成绩'}
          </button>
        </div>
      )}
    </>
  );
}

function FortuneCard({ bond, onBond, react }: Pick<Props, 'bond' | 'onBond' | 'react'>) {
  const f = useMemo(() => fortuneOf(bond.day), [bond.day]);
  const [first, setFirst] = useState(false);
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const r = drewFortune(bond);
    if (r.first) {
      onBond(r.bond);
      setFirst(true);
      react('happy');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <div className="pet-fortune">
        <span className="pet-fortune-grade">{f.grade}</span>
        <p className="pet-fortune-line">{f.line}</p>
        <dl className="pet-fortune-list">
          <dt>宜</dt>
          <dd>{f.good}</dd>
          <dt>幸运页数</dt>
          <dd>{f.pages} 页</dd>
          <dt>专注</dt>
          <dd>{f.minutes} 分钟</dd>
        </dl>
      </div>
      <div className="pet-play-foot">{first ? '抽签送了一份零食 · 明天再来抽新的' : '一天一签，明天再来抽新的'}</div>
    </>
  );
}

function BondCard({ bond, onBond }: Pick<Props, 'bond' | 'onBond'>) {
  const lv = levelOf(bond.xp);
  return (
    <>
      <div className="pet-bond-head">
        <strong>Lv.{lv.level}</strong>
        <span>{lv.title}</span>
        <span className="pet-bond-xp">{lv.next === null ? '已满级' : `${bond.xp} / ${lv.next}`}</span>
      </div>
      <div className="pet-bond-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(lv.into * 100)} aria-label="到下一级的进度">
        <i style={{ width: `${Math.round(lv.into * 100)}%` }} />
      </div>
      <p className="pet-play-hint">读一页得一份零食，完成当日目标、专注一轮、玩游戏也有。喂零食涨亲密度，升级解锁头饰。</p>
      <div className="pet-charms" role="radiogroup" aria-label="头饰">
        {LEVELS.map((l, k) => {
          const open = charmUnlocked(bond.xp, l.charm);
          return (
            <button
              key={l.charm}
              type="button"
              role="radio"
              aria-checked={bond.charm === l.charm}
              className={`pet-charm-pick${bond.charm === l.charm ? ' is-on' : ''}`}
              disabled={!open}
              title={open ? l.charmName : `Lv.${k + 1} 解锁`}
              onClick={() => onBond({ ...bond, charm: l.charm })}
            >
              <span className="pet-charm-swatch">{l.charm === 'none' ? <span className="pet-charm-none" /> : <Charm id={l.charm} />}</span>
              <span>{open ? l.charmName : `Lv.${k + 1}`}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

export function PetPlay(props: Props) {
  const { mode, style, onClose } = props;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [mode]);
  // Esc closes it even after focus has left the card (a button got disabled, a click elsewhere)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && t !== document.body && !ref.current?.contains(t)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      ref={ref}
      className={`pet-tip pet-play is-${mode}`}
      role="dialog"
      aria-label={TITLE[mode]}
      tabIndex={-1}
      style={style}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="pet-play-head">
        <span>{TITLE[mode]}</span>
        <button type="button" className="pet-play-close" onClick={onClose} aria-label="关闭" title="关闭">
          <Icon name="close" size={12} />
        </button>
      </div>
      {mode === 'rps' && <Rps {...props} />}
      {mode === 'quiz' && <Quiz {...props} />}
      {mode === 'fortune' && <FortuneCard {...props} />}
      {mode === 'bond' && <BondCard {...props} />}
    </div>
  );
}
