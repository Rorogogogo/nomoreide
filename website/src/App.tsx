import { CTA } from "./components/cta";
import { DocsPage } from "./components/docs-page";
import { Download } from "./components/download";
import { Features } from "./components/features";
import { Footer } from "./components/footer";
import { Hero } from "./components/hero";
import { HowItWorks } from "./components/how-it-works";

export default function App() {
  if (window.location.pathname === "/docs") {
    return <DocsPage />;
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Hero />
      <Features />
      <HowItWorks />
      <Download />
      <CTA />
      <Footer />
    </div>
  );
}
