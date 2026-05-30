import { CTA } from "./components/cta";
import { Features } from "./components/features";
import { Footer } from "./components/footer";
import { Hero } from "./components/hero";
import { HowItWorks } from "./components/how-it-works";

export default function App() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Hero />
      <Features />
      <HowItWorks />
      <CTA />
      <Footer />
    </div>
  );
}
