import { ClaudePane } from "./components/claude-pane";
import { CTA } from "./components/cta";
import { DocsPage } from "./components/docs-page";
import { GetStarted } from "./components/get-started";
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
      <ClaudePane />
      <GetStarted />
      <Features />
      <HowItWorks />
      <CTA />
      <Footer />
    </div>
  );
}
