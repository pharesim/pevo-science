"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/lib/auth";
import { fetchAccreditationStatus } from "@/lib/api";
import OnboardingModal from "./OnboardingModal";

export default function OnboardingModalWrapper() {
  const { username } = useAuth();
  const [isAccredited, setIsAccredited] = useState(false);

  useEffect(() => {
    if (!username) return;
    fetchAccreditationStatus(username)
      .then((res) => setIsAccredited(res.data.is_accredited))
      .catch(() => {});
  }, [username]);

  return <OnboardingModal username={username} isAccredited={isAccredited} />;
}
