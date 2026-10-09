import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { IconInfoCircle, IconLoader2 } from "@tabler/icons-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { AuthShell } from "@/components/layout/AuthShell.tsx";
import { useAuthActions, useSystemInfo } from "@/lib/session.ts";
import { ApiError } from "@/lib/api.ts";

const schema = z.object({
  displayName: z.string().min(1, "请输入显示名").max(40, "显示名最多 40 个字符"),
  email: z.string().min(1, "请输入邮箱").email("邮箱格式不正确"),
  password: z.string().min(8, "口令至少 8 个字符").max(200, "口令过长"),
  inviteCode: z.string().optional(),
});

type FormValues = z.infer<typeof schema>;

export default function RegisterPage() {
  const navigate = useNavigate();
  const { register: registerUser } = useAuthActions();
  const { data: system } = useSystemInfo();
  const [formError, setFormError] = useState<string | null>(null);
  const [becameAdmin, setBecameAdmin] = useState(false);
  const [registered, setRegistered] = useState(false);

  const isFirstUser = system?.hasUsers === false;
  const registrationOpen = system?.allowRegistration !== false;

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { displayName: "", email: "", password: "", inviteCode: "" },
  });

  const onSubmit = async (values: FormValues) => {
    setFormError(null);
    try {
      const res = await registerUser({
        email: values.email,
        password: values.password,
        displayName: values.displayName,
        inviteCode: values.inviteCode?.trim() || undefined,
      });
      setBecameAdmin(res.becameAdmin);
      setRegistered(true);
      // 首个用户已是管理员，直接进控制台
      if (res.becameAdmin) navigate("/", { replace: true });
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "注册失败，请稍后再试");
    }
  };

  if (registered && !becameAdmin) {
    return (
      <AuthShell title="注册成功" description="可以开始使用了">
        <Alert>
          <IconInfoCircle />
          <AlertTitle>账号已就绪</AlertTitle>
          <AlertDescription>
            凭邀请码注册的账号**无需审批**，现在就可以添加游戏账号并开始挂机。
          </AlertDescription>
        </Alert>
        <Button className="mt-4 w-full" onClick={() => navigate("/", { replace: true })}>
          进入控制台
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="注册"
      description={isFirstUser ? "你是第一个注册者，将自动成为管理员" : "需要管理员提供的邀请码"}
    >
      {!registrationOpen ? (
        <Alert variant="warn">
          <AlertDescription>本服务已关闭自助注册，请联系管理员创建账号。</AlertDescription>
        </Alert>
      ) : null}

      <form className="space-y-4" onSubmit={handleSubmit(onSubmit)} noValidate>
        {formError ? (
          <Alert variant="destructive">
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        ) : null}

        <div className="space-y-2">
          <Label htmlFor="displayName">显示名</Label>
          <Input id="displayName" autoComplete="nickname" placeholder="怎么称呼你" {...register("displayName")} />
          {errors.displayName ? <p className="text-destructive text-xs">{errors.displayName.message}</p> : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="email">邮箱</Label>
          <Input id="email" type="email" autoComplete="username" placeholder="you@example.com" {...register("email")} />
          {errors.email ? <p className="text-destructive text-xs">{errors.email.message}</p> : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="password">口令</Label>
          <Input id="password" type="password" autoComplete="new-password" {...register("password")} />
          {errors.password ? (
            <p className="text-destructive text-xs">{errors.password.message}</p>
          ) : (
            <p className="text-muted-foreground text-xs">至少 8 个字符</p>
          )}
        </div>

        {!isFirstUser ? (
          <div className="space-y-2">
            <Label htmlFor="inviteCode">邀请码</Label>
            <Input id="inviteCode" placeholder="由管理员生成" {...register("inviteCode")} />
            {errors.inviteCode ? <p className="text-destructive text-xs">{errors.inviteCode.message}</p> : null}
          </div>
        ) : null}

        <Button type="submit" className="w-full" disabled={isSubmitting || !registrationOpen}>
          {isSubmitting ? <IconLoader2 className="animate-spin" /> : null}
          注册
        </Button>

        <p className="text-muted-foreground text-center text-sm">
          已有账号？
          <Link to="/login" className="text-foreground underline underline-offset-4">
            去登录
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}
