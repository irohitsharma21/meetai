import { Link } from 'react-router-dom'
import {
    ArrowRight, Calendar, Captions, Check, CheckCircle2, Hand, ListChecks,
    Mic, MicOff, MonitorUp, PhoneOff, Search, ShieldCheck, Sparkles, Video, VideoIcon, X,
} from 'lucide-react'
import { usePageTitle } from '../../components/common/usePageTitle'

const FEATURES = [
    {
        icon: Captions,
        title: 'Live captions',
        text: 'Every word transcribed as it is spoken, attributed to the person who said it, and searchable the moment the call ends.',
    },
    {
        icon: ShieldCheck,
        title: 'Waiting room & host controls',
        text: 'Admit people one at a time, mute a room, remove a guest. The host stays in charge without leaving the conversation.',
    },
    {
        icon: Hand,
        title: 'Reactions & hand raise',
        text: 'Agree, applaud or ask to speak without talking over anyone. Raised hands queue in the order they went up.',
    },
    {
        icon: ListChecks,
        title: 'AI minutes & action items',
        text: 'Commitments are caught mid-sentence, confirmed with one click, and written into minutes before anyone leaves.',
    },
    {
        icon: Search,
        title: 'Ask your meetings',
        text: '"What did we decide about the deadline?" Get an answer with the exact passage it came from, across every meeting.',
    },
    {
        icon: Calendar,
        title: 'Calendar',
        text: 'Confirmed follow-ups land in Google Calendar automatically, with the meeting linked so context is one click away.',
    },
]

/** A meeting tile built from boxes; no imagery. */
function Tile({ name, hue, speaking, muted }: { name: string; hue: string; speaking?: boolean; muted?: boolean }) {
    return (
        <div className="mock-tile" data-speaking={speaking ? 'true' : undefined} style={{ background: `${hue}22` }}>
            <span className="mock-tile-avatar" style={{ background: hue }}>{name[0]}</span>
            <span className="mock-tile-name">{name}</span>
            <span className="mock-tile-mic">{muted ? <MicOff size={12} /> : <Mic size={12} />}</span>
        </div>
    )
}

function ProductMock() {
    return (
        <div className="mock" aria-hidden="true">
            <div className="mock-bar">
                <span className="mock-bar-dots"><i /><i /><i /></span>
                Q4 roadmap review
                <span className="mock-live"><i /> LIVE · 24:18</span>
            </div>
            <div className="mock-stage">
                <div className="mock-grid">
                    <Tile name="Priya" hue="#1a73e8" speaking />
                    <Tile name="Arjun" hue="#188038" />
                    <Tile name="Sam" hue="#7627bb" muted />
                    <Tile name="Lena" hue="#e37400" />
                </div>
                <div className="mock-side">
                    <div className="mock-side-title">Transcript</div>
                    <div className="mock-line"><b>Arjun · 24:02</b>We can ship the migration by Friday if QA starts Wednesday.</div>
                    <div className="mock-line"><b>Sam · 24:09</b>I'll own the QA plan and post it in the channel.</div>
                    <div className="mock-line"><b>Priya · 24:15</b>Then let's lock the deadline for the 24th.</div>
                </div>
            </div>
            <div className="mock-chip">
                <span className="mock-chip-icon"><CheckCircle2 size={14} /></span>
                <span className="mock-chip-text">
                    <b>Action item detected</b>
                    <span>Sam · QA plan · by Wednesday</span>
                </span>
                <span className="mock-chip-actions"><i><Check size={13} /></i><i><X size={13} /></i></span>
            </div>
            <div className="mock-caption">
                <b>Priya</b>
                <span>Then let's lock the deadline for the 24th</span>
                <span className="mock-caption-cursor" />
            </div>
            <div className="mock-controls">
                <i><Mic size={15} /></i>
                <i><VideoIcon size={15} /></i>
                <i><MonitorUp size={15} /></i>
                <i><Hand size={15} /></i>
                <i data-danger=""><PhoneOff size={15} /></i>
            </div>
        </div>
    )
}

/**
 * Marketing page for signed-out visitors. Signed-in users are redirected to
 * the dashboard before this renders (see RootRoute in App.tsx).
 */
export function LandingPage() {
    usePageTitle('Meetings that write their own minutes')

    return (
        <div className="landing">
            <nav className="landing-nav" aria-label="Site">
                <Link to="/" className="rail-brand" style={{ margin: 0 }} aria-label="MeetAI home">
                    <span className="rail-mark"><Video size={16} aria-hidden="true" /></span>
                    <span className="rail-brand-text">MeetAI</span>
                </Link>
                <div className="landing-nav-links">
                    <a href="#features">Features</a>
                    <a href="#minutes">Minutes</a>
                    <a href="#ask">Ask</a>
                </div>
                <div className="landing-nav-cta">
                    <Link to="/login" className="btn btn-ghost">Sign in</Link>
                    <Link to="/register" className="btn btn-primary">Create account</Link>
                </div>
            </nav>

            <main>
                <section className="landing-wrap hero">
                    <div>
                        <span className="hero-eyebrow"><Sparkles size={14} aria-hidden="true" /> AI-assisted video meetings</span>
                        <h1 className="hero-title">Meetings that write their <em>own minutes</em>.</h1>
                        <p className="hero-sub">
                            HD video with live captions, host controls and an assistant that
                            catches every commitment as it is made. Leave the call with the
                            minutes, the action items and a searchable record already done.
                        </p>
                        <div className="hero-cta">
                            <Link to="/register" className="btn btn-primary btn-lg">
                                Create account <ArrowRight size={16} aria-hidden="true" />
                            </Link>
                            <Link to="/login" className="btn btn-lg">Sign in</Link>
                        </div>
                        <div className="hero-proof">
                            <span><Check size={14} aria-hidden="true" /> No installs</span>
                            <span><Check size={14} aria-hidden="true" /> Works in the browser</span>
                            <span><Check size={14} aria-hidden="true" /> Join with a code</span>
                        </div>
                    </div>
                    <ProductMock />
                </section>

                <section id="features" className="landing-wrap landing-section">
                    <div className="landing-section-head">
                        <h2>Everything a meeting needs. Nothing to clean up afterwards.</h2>
                        <p>Run the call the way you already do. MeetAI listens, keeps the record, and does the follow-up work.</p>
                    </div>
                    <div className="features">
                        {FEATURES.map(({ icon: Icon, title, text }) => (
                            <article className="feature" key={title}>
                                <span className="feature-icon"><Icon size={22} aria-hidden="true" /></span>
                                <h3>{title}</h3>
                                <p>{text}</p>
                            </article>
                        ))}
                    </div>
                </section>

                <section id="minutes" className="landing-wrap landing-section" style={{ paddingTop: 0 }}>
                    <div className="landing-band">
                        <div>
                            <h2>Minutes before you hang up</h2>
                            <p>
                                The summary, the minutes and the next actions are generated from the
                                transcript on demand. Review them in the wrap-up panel, then send a
                                digest to everyone who attended.
                            </p>
                            <div className="hero-cta" style={{ marginTop: '1.25rem' }}>
                                <Link to="/register" className="btn btn-primary">Try it free</Link>
                            </div>
                        </div>
                        <div className="minutes-mock" aria-hidden="true">
                            <h4>Minutes · Q4 roadmap review</h4>
                            <div className="line" style={{ width: '92%' }} />
                            <div className="line" style={{ width: '78%' }} />
                            <div className="line" style={{ width: '85%' }} />
                            <h4 style={{ marginTop: '1rem' }}>Next actions</h4>
                            <ul>
                                <li><CheckCircle2 size={15} /> Sam posts the QA plan in the channel by Wednesday</li>
                                <li><CheckCircle2 size={15} /> Arjun ships the migration by Friday</li>
                                <li><CheckCircle2 size={15} /> Priya locks the deadline for the 24th</li>
                            </ul>
                        </div>
                    </div>
                </section>

                <section id="ask" className="landing-wrap landing-section" style={{ paddingTop: 0 }}>
                    <div className="landing-band" style={{ background: 'var(--accent-soft)' }}>
                        <div className="minutes-mock" aria-hidden="true">
                            <div className="ask-composer" style={{ position: 'static', boxShadow: 'none', marginBottom: '0.875rem' }}>
                                <Search size={16} />
                                <span style={{ flex: 1, fontSize: '0.875rem' }}>Who owns the migration?</span>
                            </div>
                            <p style={{ fontSize: '0.875rem', lineHeight: 1.55 }}>
                                <b>Arjun</b> owns the migration and committed to shipping it by Friday,
                                with QA starting Wednesday.
                            </p>
                            <div className="passage" style={{ marginTop: '0.75rem', cursor: 'default' }}>
                                <div className="passage-head">
                                    <span className="passage-title">Q4 roadmap review</span>
                                    <span className="passage-meta">24:02 · 94% match</span>
                                </div>
                                <div className="passage-body">
                                    <span className="passage-speaker">Arjun</span>
                                    We can ship the migration by Friday if QA starts Wednesday.
                                </div>
                            </div>
                        </div>
                        <div>
                            <h2>Ask your meetings anything</h2>
                            <p>
                                Semantic search across every transcript. Answers cite the passage
                                they came from, so you can check the source in one click.
                            </p>
                        </div>
                    </div>
                </section>

                <section className="landing-wrap cta-band">
                    <h2>Start your first meeting in a minute</h2>
                    <p>Create an account, share a code, and let the minutes write themselves.</p>
                    <div className="hero-cta">
                        <Link to="/register" className="btn btn-primary btn-lg">Create account</Link>
                        <Link to="/login" className="btn btn-lg">Sign in</Link>
                    </div>
                </section>
            </main>

            <footer className="landing-footer">
                <div className="landing-wrap landing-footer-row">
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        <span className="rail-mark" style={{ width: 22, height: 22, borderRadius: 6 }}><Video size={12} aria-hidden="true" /></span>
                        MeetAI
                    </span>
                    <div className="landing-footer-links">
                        <a href="#features">Features</a>
                        <Link to="/login">Sign in</Link>
                        <Link to="/register">Create account</Link>
                    </div>
                    <span>© {new Date().getFullYear()} MeetAI</span>
                </div>
            </footer>
        </div>
    )
}
