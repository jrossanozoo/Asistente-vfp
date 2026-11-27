define class TiposArgumento as Custom
	function Recibir( tcTexto as String, tnNumero as Integer, tdFecha as Date, tlFlag as Logical, toObj as Custom, tvCualquiera ) as Void
	endfunc
	function Usar() as Void
		local lnCant as Integer, lcNombre as Character, loX as Custom, ldHoy as DateTime, luSinTipo
		this.Recibir( "ok", 1, {^2026-01-01}, .T., loX, 3 )
		this.Recibir( 12, "dos", "tres", 1, "obj", "nada" )
		this.Recibir( [texto], 1.5, {^2026-01-01 10:30}, .F., .NULL., .NULL. )
		this.Recibir( lnCant, lcNombre, ldHoy, luSinTipo, lnCant )
		this.Recibir( 'a', ;
			.T. )
	endfunc
enddefine
function Suelta( tnValor as Number ) as Void
endfunc
procedure UsarSuelta
	Suelta( "x" )
	Suelta( 5 )
	NoExiste( "x" )
	ConTypo( 1, "x" )
endproc
function ConTypo( tcX as Stirng, tcY as as String ) as Void
endfunc
