import { Composition } from "remotion";
import { TitleCard, titleCardSchema } from "./compositions/title-card";
import { KineticText, kineticTextSchema } from "./compositions/kinetic-text";
import { SocialPost, socialPostSchema } from "./compositions/social-post";
import { Countdown, countdownSchema } from "./compositions/countdown";
import { LogoReveal, logoRevealSchema } from "./compositions/logo-reveal";
import { GradientWave, gradientWaveSchema } from "./compositions/gradient-wave";
import { BabetteWelcome } from "./compositions/babette-welcome";

export const Root: React.FC = () => {
  return (
    <>
      <Composition
        id="TitleCard"
        component={TitleCard}
        schema={titleCardSchema}
        durationInFrames={150}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          title: "Your Title Here",
          subtitle: "A beautiful subtitle with smooth animations",
          backgroundColor: "#1e1b4b",
          textColor: "#ffffff",
          accentColor: "#818cf8",
        }}
      />

      <Composition
        id="KineticText"
        component={KineticText}
        schema={kineticTextSchema}
        durationInFrames={180}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          lines: ["DREAM", "BUILD", "LAUNCH"],
          backgroundColor: "#0f172a",
          textColor: "#f8fafc",
          accentColor: "#38bdf8",
          fontWeight: "900",
        }}
      />

      <Composition
        id="SocialPost"
        component={SocialPost}
        schema={socialPostSchema}
        durationInFrames={120}
        fps={30}
        width={1080}
        height={1080}
        defaultProps={{
          headline: "Big News!",
          body: "We just launched our new product. Check it out and see what's possible.",
          cta: "Learn More →",
          backgroundColor: "#7c3aed",
          textColor: "#ffffff",
          accentColor: "#fbbf24",
        }}
      />

      <Composition
        id="Countdown"
        component={Countdown}
        schema={countdownSchema}
        durationInFrames={210}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          from: 5,
          endText: "GO!",
          backgroundColor: "#0f172a",
          textColor: "#ffffff",
          accentColor: "#ef4444",
        }}
      />

      <Composition
        id="LogoReveal"
        component={LogoReveal}
        schema={logoRevealSchema}
        durationInFrames={120}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          text: "BRAND",
          tagline: "Your tagline here",
          backgroundColor: "#000000",
          textColor: "#ffffff",
          accentColor: "#f59e0b",
        }}
      />

      <Composition
        id="GradientWave"
        component={GradientWave}
        schema={gradientWaveSchema}
        durationInFrames={180}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          title: "OpenVideo Studio",
          subtitle: "Programmatic video creation powered by Remotion",
          colorFrom: "#6366f1",
          colorTo: "#ec4899",
          textColor: "#ffffff",
        }}
      />

      <Composition
        id="BabetteWelcome"
        component={BabetteWelcome}
        durationInFrames={150}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          salonName: "Babette",
          tagline: "Haute Coiffure Parisienne",
          welcomeText: "Bienvenue",
          locationText: "Paris, France",
          backgroundColor: "#0d0b07",
          textColor: "#f5ead6",
          accentColor: "#c9a84c",
          goldColor: "#d4af37",
          mutedColor: "#b8a98a",
        }}
      />

      {/* Square variants */}
      <Composition
        id="TitleCard-Square"
        component={TitleCard}
        schema={titleCardSchema}
        durationInFrames={150}
        fps={30}
        width={1080}
        height={1080}
        defaultProps={{
          title: "Your Title Here",
          subtitle: "Perfect for Instagram and social media",
          backgroundColor: "#1e1b4b",
          textColor: "#ffffff",
          accentColor: "#818cf8",
        }}
      />

      <Composition
        id="KineticText-Reel"
        component={KineticText}
        schema={kineticTextSchema}
        durationInFrames={180}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{
          lines: ["SWIPE", "UP", "NOW"],
          backgroundColor: "#0f172a",
          textColor: "#f8fafc",
          accentColor: "#38bdf8",
          fontWeight: "900",
        }}
      />
    </>
  );
};
