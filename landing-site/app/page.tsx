// Root of calproduct.com — and the fallback for any stripped/unknown slug.
const CAL_URL = 'https://cal.com/adit-mittal/30min';

export default function Home() {
  return (
    <main className="home">
      <div>
        <p className="eyebrow" style={{ marginBottom: 18 }}>Adit &amp; Asim · Berkeley</p>
        <h1 className="serif">Let&apos;s talk product.</h1>
        <p>We aren&apos;t pitching, we just want to learn about how your team decides what to build.</p>
        <a className="btn big" href={CAL_URL}>Book a 30-min chat →</a>
      </div>
    </main>
  );
}
